import { loadEnvFile } from 'node:process';
import { join } from 'node:path';

export function loadProjectEnv(root: string): void {
  try { loadEnvFile(join(root, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
