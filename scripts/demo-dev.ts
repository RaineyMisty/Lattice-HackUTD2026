import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { AgentManager, CodexHarness, printAgentActivity, SpacetimeExplorationDatabase, type CodingHarness, type ExplorationHandle } from '../agents/src/index.ts';
import { repositoryRevision, repositoryRoot } from '../agents/src/explorer/repository.ts';
import { serviceEntryPaths } from '../agents/src/explorer/entrypoint.ts';
import { tables, type DbConnection, type Simulation } from '../spacetime_db/client/index.ts';
import { connectDatabase, grantOperator, publisherToken, spacetimeCli } from './local-world.ts';

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
  serviceEntries?: ReadonlyMap<string, string>;
  simulationId?: string;
  run?: ExplorationHandle;
}

async function localRepositories(directory: string) {
  const repositories = new Map<string, DemoRepository>();
  const folders = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    try {
      const path = await repositoryRoot(join(directory, folder.name));
      const { commit, tracked } = await repositoryRevision(path);
      const serviceEntries = serviceEntryPaths(tracked);
      const worldId = `repo-${randomUUID()}`;
      repositories.set(worldId, { worldId, path, name: basename(path), commit, serviceEntries: serviceEntries.size ? serviceEntries : undefined });
    } catch (error) {
      log(`Skipping ${folder.name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return repositories;
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
  const turns = options.turns ?? Number(process.env.LATTICE_DEMO_TURNS ?? 16);
  if (!Number.isInteger(turns) || turns < 1 || turns > 32) throw new Error('LATTICE_DEMO_TURNS must be between 1 and 32');
  if (dbPort === webPort || await listening(dbPort) || await listening(webPort)) {
    throw new Error(`Demo ports ${webPort} (web) and ${dbPort} (database) must be free`);
  }
  const dataDirectory = resolve(options.dataDirectory ?? join(root, '.data', 'interactive-demo'));
  const repositories = await localRepositories(resolve(options.repositoryDirectory ?? join(root, 'repo')));
  const initial = [...repositories.values()].find(repository => repository.name === 'train-ticket') ?? repositories.values().next().value;
  if (!initial) throw new Error('Add a clean Git checkout to the repo directory');
  const { worldId } = initial;
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
  let closed = false;
  let closing: Promise<void> | undefined;

  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      try {
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
    log(`Preparing ${repositories.size} Git repositories and local SpacetimeDB on port ${dbPort}`);
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
    for (const repository of repositories.values()) {
      await owner.reducers.createWorld({ id: repository.worldId, repository: repository.name, commit: repository.commit });
    }
    const operatorToken = await grantOperator(owner, config, [...repositories.keys()]);

    const simulations = [...repositories.keys()].map(id => tables.worldSimulations.where(row => row.worldId.eq(id)));
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
          repositoryPath: repository.path, agentCount: 4, maxTurnsPerAgent: turns, serviceEntries: repository.serviceEntries,
        });
        repository.run = handle;
        log(`${repository.name} exploration started with four Agents (${turns} turns maximum per Agent)`);
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
        log(`Reset committed for ${repository.name}; stopping active Explorers`);
        pending = pending.then(async () => { await repository.run?.stop(); }).catch(error => log(`Could not stop exploration — ${String(error)}`));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out subscribing to demo controls')), 10_000);
      client.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); resolve(); })
        .onError(() => { clearTimeout(timer); reject(new Error('Could not subscribe to demo controls')); })
        .subscribe(simulations);
    });

    const browserPath = `/?world=${encodeURIComponent(worldId)}#operator=${encodeURIComponent(operatorToken)}`;
    vite = await createServer({
      root: join(root, 'frontend'),
      configFile: join(root, 'frontend', 'vite.config.ts'),
      define: {
        'import.meta.env.VITE_LATTICE_DB_URL': JSON.stringify(uri),
        'import.meta.env.VITE_LATTICE_DATABASE': JSON.stringify(database),
        'import.meta.env.VITE_LATTICE_WORLD_ID': JSON.stringify(worldId),
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
    return { worldId, browserUrl, config, close, getRun: (id = worldId) => repositories.get(id)?.run };
  } catch (error) {
    await close();
    throw error;
  }
}
