import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = resolve(root, '.data/test-temp');
mkdirSync(temporary, { recursive: true });
const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
const suites = process.argv.includes('--database-only') ? ['spacetime_db/test/live.test.ts'] : ['agents/harness/model.test.ts', 'agents/harness/tools.test.ts'];
const commands = [['--import', 'tsx', '--test', ...suites]];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) { console.error(result.error); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
