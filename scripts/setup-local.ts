import { mkdirSync, writeFileSync } from 'node:fs';
import { tables } from '../spacetime_db/client';
import deployment from '../spacetime_db/connection.json';
import { connectDatabase, grantOperator, publisherToken } from './local-world.ts';

const uri = process.env.LATTICE_DB_URL ?? deployment.local.uri;
const database = process.env.LATTICE_DATABASE ?? deployment.local.database;
const port = Number(process.env.LATTICE_WEB_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid LATTICE_WEB_PORT');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname)) {
  throw new Error('Local setup requires a loopback SpacetimeDB instance');
}
const worldId = process.env.LATTICE_WORLD_ID?.trim();
if (!worldId) throw new Error('Set LATTICE_WORLD_ID to an existing repository world');
const config = { uri, database };
const { client: owner } = await connectDatabase({ ...config, token: publisherToken() });
try {
  const query = tables.myWorlds.where(row => row.id.eq(worldId));
  await new Promise<void>((resolve, reject) => {
    owner.subscriptionBuilder().onApplied(() => resolve()).onError(ctx => reject(ctx.event))
      .subscribe(query);
  });
  const [world] = owner.db.myWorlds.iter();
  if (!world || /^0+$/.test(world.commit)) throw new Error('Choose an existing world with a repository commit');

  const token = await grantOperator(owner, config, worldId);
  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/repository-ui.json', JSON.stringify({ uri, database, worldId, port }));
  writeFileSync('.data/repository-operator-url.txt', `http://127.0.0.1:${port}/?world=${encodeURIComponent(worldId)}#operator=${encodeURIComponent(token)}\n`, { mode: 0o600 });
  console.log('Open the private link in .data/repository-operator-url.txt.');
} finally {
  owner.disconnect();
}
