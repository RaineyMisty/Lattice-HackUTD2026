import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], { cwd: root, stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', 'apps/web'], { cwd: root, stdio: 'inherit', env: process.env }),
];
let ending = false;
function stop(code = 0) { if (ending) return; ending = true; for (const child of children) child.kill(); process.exitCode = code; }
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => stop(code ?? 0)); }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
