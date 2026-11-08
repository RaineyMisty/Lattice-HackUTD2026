import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DbConnection } from '../db/client';

const uri = process.env.LATTICE_DB_URL ?? 'http://127.0.0.1:3000';
const database = process.env.LATTICE_DATABASE ?? 'lattice-demo';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname)) {
  throw new Error('Local setup requires a loopback SpacetimeDB instance');
}
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const cliRoot = process.env.SPACETIME_ROOT;
const cliArgs = cliRoot ? ['--root-dir', cliRoot] : [];
function register(reducer: string, ...args: string[]) {
  const result = spawnSync(cli, [...cliArgs, 'call', '--server', uri, database, reducer, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not call ${reducer} with the publishing identity`);
}
function identity() {
  return new Promise<{ identity: string; token: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.disconnect();
      reject(new Error('Timed out opening the database'));
    }, 10_000);
    const conn = DbConnection.builder().withUri(uri).withDatabaseName(database)
      .onConnect((client, id, token) => {
        clearTimeout(timeout);
        resolve({ identity: id.toHexString(), token });
        client.disconnect();
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeout);
        reject(error);
      })
      .build();
  });
}
mkdirSync('.data', { recursive: true });
const operator = await identity();
register('register_operator', operator.identity);
for (const role of ['A', 'B', 'C', 'D']) {
  const agent = await identity();
  register('register_agent', agent.identity, role);
  writeFileSync(`.data/agent-${role}.token`, agent.token, { mode: 0o600 });
}
writeFileSync('.data/lattice.json', JSON.stringify({ uri, database }));
writeFileSync('.data/operator-url.txt', `http://127.0.0.1:5173/#operator=${encodeURIComponent(operator.token)}\n`, { mode: 0o600 });
console.log('Registered one operator and four agents. Open the link saved in .data/operator-url.txt.');
