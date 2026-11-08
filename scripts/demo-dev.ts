import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { AgentManager, CodexHarness, printAgentActivity, SpacetimeExplorationDatabase, type CodingHarness, type ExplorationHandle } from '../agents/src/index.ts';
import { repositoryHead, repositoryRevision, repositoryRoot } from '../agents/src/explorer/repository.ts';
import { tables, type DbConnection, type Simulation } from '../spacetime_db/client/index.ts';
import { connectDatabase, publisherToken, spacetimeCli } from './local-world.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const log = (message: string) => printAgentActivity({ at: new Date().toISOString(), agentId: 'demo', kind: 'lifecycle', message });

interface DemoOptions {
  harness?: CodingHarness;
  openBrowser?: boolean;
  dbPort?: number;
  webPort?: number;
  dataDirectory?: string;
  turns?: number;
  repositoryDirectory?: string;
}

interface DemoRepository {
  worldId: string;
  path: string;
  name: string;
  commit: string;
  role?: 'reader' | 'operator';
  simulationId?: string;
  run?: ExplorationHandle;
}

async function repositoryFolders(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
}

function port(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}

function listening(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(350, () => finish(false));
  });
}

function exitStatus(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

function stopServer(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill();
  }
}

export async function startDemo(options: DemoOptions = {}) {
  const dbPort = port(options.dbPort ?? Number(process.env.LATTICE_DEMO_DB_PORT ?? 3382), 'LATTICE_DEMO_DB_PORT');
  const configuredWebPort = options.webPort ?? process.env.LATTICE_WEB_PORT;
  let webPort = port(Number(configuredWebPort ?? 5173), 'LATTICE_WEB_PORT');
  if (configuredWebPort === undefined) {
    while (webPort < 5183 && (webPort === dbPort || await listening(webPort))) webPort++;
  }
  const turns = options.turns;
  if (dbPort === webPort || await listening(dbPort) || await listening(webPort)) {
    throw new Error(`Demo ports ${webPort} (web) and ${dbPort} (database) must be free`);
  }
  const dataDirectory = resolve(options.dataDirectory ?? join(root, '.data', 'interactive-demo'));
  const repositoryDirectory = resolve(options.repositoryDirectory ?? join(root, 'repo'));
  const repositories = new Map<string, DemoRepository>();
  const folders = new Map<string, DemoRepository>();
  const { command, args } = spacetimeCli();
  const token = publisherToken();
  const uri = `http://127.0.0.1:${dbPort}`;
  const database = 'lattice-train-ticket-demo';
  const config = { uri, database };
  const modelReady = !!options.harness || !!process.env.NVIDIA_API_KEY?.trim();
  const label = 'Repository demo';
  let server: ChildProcess | undefined;
  let owner: DbConnection | undefined;
  let vite: ViteDevServer | undefined;
  let pending = Promise.resolve();
  let discovery: Promise<void> | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function close() {
    if (closing) return closing;
    closed = true;
    clearInterval(discoveryTimer);
    closing = (async () => {
      try {
        await discovery;
        await pending;
        await Promise.all([...repositories.values()].map(repository => repository.run?.stop()));
      } finally {
        try {
          await vite?.close();
        } finally {
          owner?.disconnect();
          stopServer(server);
        }
      }
    })();
    return closing;
  }

  try {
    log(`Preparing local SpacetimeDB on port ${dbPort}`);
    await mkdir(dataDirectory, { recursive: true });
    server = spawn(command, [...args, 'start', '--non-interactive', '--listen-addr', `127.0.0.1:${dbPort}`,
      '--data-dir', join(dataDirectory, 'data'), '--jwt-pub-key-path', join(dataDirectory, 'jwt.pub.pem'),
      '--jwt-priv-key-path', join(dataDirectory, 'jwt.key.pem')], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let serverError = '';
    let spawnError: Error | undefined;
    server.stderr?.on('data', data => { serverError = (serverError + String(data)).slice(-800); });
    server.on('error', error => { spawnError = error; });
    const until = Date.now() + 15_000;
    while (!(await listening(dbPort))) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || Date.now() >= until) throw new Error(`Local SpacetimeDB failed to start. ${serverError}`);
      await pause(100);
    }
    const publish = spawn(command, [...args, 'publish', database, '--server', uri, '--module-path', 'spacetime_db', '--yes=skip-login'],
      { cwd: root, stdio: 'inherit', windowsHide: true });
    if (await exitStatus(publish) !== 0) throw new Error('Could not publish the local SpacetimeDB module');
    log('Local database ready; creating isolated repository worlds');

    const { client } = await connectDatabase({ ...config, token });
    owner = client;
    const { client: operator, token: operatorToken } = await connectDatabase(config);
    const identity = operator.identity!;
    operator.disconnect();

    async function scanRepositories() {
      for (const folder of await repositoryFolders(repositoryDirectory)) {
        if (closed) return;
        let repository = folders.get(folder.name);
        if (repository?.role === 'operator') continue;
        if (!repository) {
          const candidate = join(repositoryDirectory, folder.name);
          if (!await stat(join(candidate, '.git')).catch(() => null)) continue;
          const path = await repositoryRoot(candidate).catch(() => null);
          if (!path) continue;
          const commit = await repositoryHead(path).catch(() => null);
          if (!commit) continue; // A clone may still be fetching its first commit.
          const worldId = `repo-${randomUUID()}`;
          repository = { worldId, path, name: basename(path), commit };
          await client.reducers.createWorld({ id: worldId, repository: repository.name, commit });
          folders.set(folder.name, repository);
          repositories.set(worldId, repository);
        }
        const revision = await repositoryRevision(repository.path).catch(() => null);
        const ready = revision?.commit === repository.commit;
        const role = ready ? 'operator' : 'reader';
        if (role === repository.role) continue;
        await client.reducers.setMember({ worldId: repository.worldId, identity, role });
        repository.role = role;
        log(`Repository ${repository.name} ${ready ? 'ready' : 'listed; waiting for a clean checkout'} (${repository.commit.slice(0, 7)})`);
      }
    }

    await scanRepositories();
    const ready = [...repositories.values()].filter(repository => repository.role === 'operator');
    const worldId = (ready.find(repository => repository.name === 'train-ticket') ?? ready[0]
      ?? repositories.values().next().value)?.worldId;
    const start = (row: Simulation) => {
      const repository = repositories.get(row.worldId);
      if (closed || !repository || repository.simulationId || !modelReady || row.label !== label || row.status !== 'running') return;
      repository.simulationId = row.id;
      log(`Start committed for ${repository.name}; preparing four Explorer sessions`);
      pending = pending.then(async () => {
        if (closed || client.db.worldSimulations.id.find(row.id)?.status !== 'running') return;
        const harness = options.harness ?? new CodexHarness({ provider: 'nvidia' });
        const manager = new AgentManager({
          database: new SpacetimeExplorationDatabase({ ...config, token, worldId: repository.worldId }), harness, onActivity: printAgentActivity,
        });
        const handle = await manager.start({
          repositoryPath: repository.path, agentCount: 4, maxTurnsPerAgent: turns,
        });
        repository.run = handle;
        log(`${repository.name} exploration started with four Agents (${turns === undefined ? 'continuous Frontier' : turns + ' turns maximum per Agent'})`);
        void handle.done.then(async result => {
          const { world } = await manager.getContext(handle.id);
          const queued = world?.frontier.filter(task => task.status === 'queued').length ?? 0;
          log(`${repository.name} exploration ${result.phase}. ${world?.entities.length ?? 0} entities, ${world?.relations.length ?? 0} relations, ${world?.behaviors.length ?? 0} behaviors. ${queued} tasks remain queued.`);
        }).catch(error => log(`Could not summarize exploration — ${error instanceof Error ? error.message : String(error)}`));
      }).catch(error => log(`Could not start exploration — ${error instanceof Error ? error.message : String(error)}`));
    };
    client.db.worldSimulations.onInsert((_context, row) => start(row));
    client.db.worldSimulations.onUpdate((_context, _before, row) => {
      const repository = repositories.get(row.worldId);
      if (repository && row.id === repository.simulationId && row.status === 'stopped') {
        repository.simulationId = undefined;
        log(`Reset committed for ${repository.name}; stopping active Explorers`);
        pending = pending.then(async () => { await repository.run?.stop(); }).catch(error => log(`Could not stop exploration — ${String(error)}`));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out subscribing to demo controls')), 10_000);
      client.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); resolve(); })
        .onError(() => { clearTimeout(timer); reject(new Error('Could not subscribe to demo controls')); })
        .subscribe(tables.worldSimulations);
    });

    const browserPath = `/${worldId ? `?world=${encodeURIComponent(worldId)}` : ''}#operator=${encodeURIComponent(operatorToken)}`;
    vite = await createServer({
      root: join(root, 'frontend'),
      configFile: join(root, 'frontend', 'vite.config.ts'),
      define: {
        'import.meta.env.VITE_LATTICE_DB_URL': JSON.stringify(uri),
        'import.meta.env.VITE_LATTICE_DATABASE': JSON.stringify(database),
        'import.meta.env.VITE_LATTICE_WORLD_ID': JSON.stringify(worldId ?? ''),
        'import.meta.env.VITE_LATTICE_DEMO_MODEL_READY': JSON.stringify(modelReady),
        'import.meta.env.VITE_LATTICE_DEMO_LABEL': JSON.stringify(label),
      },
      server: {
        port: webPort, open: options.openBrowser === false ? false : browserPath,
        fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**'] },
      },
    });
    const browserUrl = `http://127.0.0.1:${webPort}${browserPath}`;
    await writeFile(join(dataDirectory, 'browser-url.txt'), browserUrl + '\n', { mode: 0o600 });
    await vite.listen();
    vite.printUrls();
    log(modelReady ? 'Waiting for the browser Start button; model requests have not started'
      : 'Waiting for the browser Start button; set NVIDIA_API_KEY and restart to enable exploration');
    discoveryTimer = setInterval(() => {
      if (discovery) return;
      discovery = scanRepositories()
        .catch(error => log(`Could not refresh repositories — ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { discovery = undefined; });
    }, 2000).unref();
    return { worldId, browserUrl, config, close, getRun: (id = worldId) => id ? repositories.get(id)?.run : undefined };
  } catch (error) {
    await close();
    throw error;
  }
}
