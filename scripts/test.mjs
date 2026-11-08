import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = resolve(root, '.data/test-temp');
mkdirSync(temporary, { recursive: true });
const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
const commands = [
  ...(!process.argv.includes('--database-only') ? [[
    '--import', 'tsx', '--test',
    'db/src/domain/domain.test.ts',
    'agents/src/runner.test.ts',
  ]] : []),
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'db/vitest.config.ts'],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) { console.error(result.error); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
