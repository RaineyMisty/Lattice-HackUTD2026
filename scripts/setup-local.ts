import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tables, worldConnection, type DbConnection } from '../spacetime_db/client';
import deployment from '../spacetime_db/connection.json';

const uri = process.env.LATTICE_DB_URL ?? deployment.local.uri;
const database = process.env.LATTICE_DATABASE ?? deployment.local.database;
const port = Number(process.env.LATTICE_WEB_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LATTICE_WEB_PORT');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname)) {
  throw new Error('Local setup requires a loopback SpacetimeDB instance');
}
const worldId = process.env.LATTICE_WORLD_ID?.trim();
if (!worldId) throw new Error('Set LATTICE_WORLD_ID to an existing repository world');
const windowsCli = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
const cli = process.env.SPACETIME_CLI ?? (windowsCli && existsSync(windowsCli) ? windowsCli : 'spacetime');
const cliArgs = process.env.SPACETIME_ROOT ? ['--root-dir', process.env.SPACETIME_ROOT] : [];
const login = spawnSync(cli, [...cliArgs, 'login', 'show', '--token'], { encoding: 'utf8', windowsHide: true });
if (login.error) throw login.error;
const ownerToken = login.stdout.match(/eyJ[A-Za-z0-9_.-]+/)?.[0];
if (login.status !== 0 || !ownerToken) throw new Error('Log in with the identity that published the local database');

function connect(token?: string) {
  return new Promise<{ client: DbConnection; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timed out opening the local database'));
    }, 10_000);
    const client = worldConnection({ uri, database, token })
      .onConnect((client, _identity, token) => {
        clearTimeout(timer);
        resolve({ client, token });
      })
      .onConnectError((_context, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .build();
  });
}

const { client: owner } = await connect(ownerToken);
try {
  const query = tables.myWorlds.where(row => row.id.eq(worldId));
  await new Promise<void>((resolve, reject) => {
    owner.subscriptionBuilder().onApplied(() => resolve()).onError(ctx => reject(ctx.event))
      .subscribe(query);
  });
  const [world] = owner.db.myWorlds.iter();
  if (!world || /^0+$/.test(world.commit)) throw new Error('Choose an existing world with a repository commit');

  const { client: operator, token } = await connect();
  try {
    await owner.reducers.setMember({ worldId, identity: operator.identity!, role: 'operator' });
    mkdirSync('.data', { recursive: true });
    writeFileSync('.data/repository-ui.json', JSON.stringify({ uri, database, worldId, port }));
    writeFileSync('.data/repository-operator-url.txt', `http://127.0.0.1:${port}/#operator=${encodeURIComponent(token)}\n`, { mode: 0o600 });
    console.log('Open the private link in .data/repository-operator-url.txt.');
  } finally {
    operator.disconnect();
  }
} finally {
  owner.disconnect();
}
