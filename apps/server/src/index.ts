import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoServer } from './server.js';
import { loadProjectEnv } from '../../../packages/agents/src/env.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
loadProjectEnv(root);
const port = Number(process.env.LATTICE_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LATTICE_PORT must be a valid TCP port');
const instance = await createDemoServer({
  dataDirectory: resolve(root, process.env.LATTICE_DATA_DIR ?? '.data'), port,
});
console.log(`Lattice local reducer simulator: ${instance.url}`);
console.log('Persistent world: .data/world.json · SpacetimeDB is not connected in local mode');
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await instance.close();
};
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
