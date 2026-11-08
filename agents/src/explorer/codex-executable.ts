import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

function findNpmCodex(shim: string): string | undefined {
  if (!existsSync(shim) || (process.arch !== 'x64' && process.arch !== 'arm64')) return;

  const bin = dirname(shim);
  const modules = basename(bin).toLowerCase() === '.bin' ? dirname(bin) : join(bin, 'node_modules');
  const pkg = join(modules, '@openai', 'codex', 'package.json');
  if (!existsSync(pkg)) return;

  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  let nativePackage = pkg;
  try {
    nativePackage = createRequire(pkg).resolve(`@openai/codex-win32-${process.arch}/package.json`);
  } catch {
    // Older npm releases bundle the native binary in the main package.
  }
  const executable = join(dirname(nativePackage), 'vendor', target, 'bin', 'codex.exe');
  if (existsSync(executable)) return executable;
}

export function resolveCodexExecutable(codexPath?: string): string {
  if (process.platform !== 'win32') return codexPath ?? 'codex';
  if (codexPath) {
    if (!codexPath.toLowerCase().endsWith('.cmd')) return codexPath;
    const executable = findNpmCodex(resolve(codexPath));
    if (executable) return executable;
    throw new Error('Could not resolve the Codex npm shim. Pass the path to codex.exe with --codex-path.');
  }

  // Node can spawn codex.exe directly, including when npm only puts codex.cmd on PATH.
  const directories = (process.env.PATH ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/g, ''));
  if (process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'));
  for (const directory of directories.filter(isAbsolute)) {
    const executable = join(directory, 'codex.exe');
    if (existsSync(executable)) return executable;
    const npmExecutable = findNpmCodex(join(directory, 'codex.cmd'));
    if (npmExecutable) return npmExecutable;
  }
  throw new Error('Codex CLI not found. Install @openai/codex with npm or pass --codex-path to codex.exe.');
}
