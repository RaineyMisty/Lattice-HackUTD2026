import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let config = {};
try {
  config = JSON.parse(readFileSync(new URL('../.data/repository-ui.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const env = { ...process.env };
if (config.uri) env.VITE_LATTICE_DB_URL ??= config.uri;
if (config.database) env.VITE_LATTICE_DATABASE ??= config.database;
if (config.worldId && env.VITE_LATTICE_DB_URL === config.uri && env.VITE_LATTICE_DATABASE === config.database) {
  env.VITE_LATTICE_WORLD_ID ??= config.worldId;
}
if (config.port) env.LATTICE_WEB_PORT ??= String(config.port);
const frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'frontend/vite.config.ts', 'frontend'], {
  cwd: root, stdio: 'inherit', env,
});
frontend.on('error', error => { console.error(error.message); process.exitCode = 1; });
frontend.on('exit', code => { process.exitCode = code ?? 0; });
process.once('SIGINT', () => frontend.kill());
process.once('SIGTERM', () => frontend.kill());
