import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

const excluded = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', '.next']);
const extensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.vue', '.svelte', '.proto', '.sql', '.sh',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.tf', '.md', '.gradle', '.sln',
]);
const maxSourceBytes = 512 * 1024;
const excludedName = (name: string) => excluded.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name)
  || /\.(pem|key|pfx|p12)$/i.test(name);
const slash = (value: string) => value.replaceAll('\\', '/');

export function stableId(prefix: string, ...parts: unknown[]) {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

export async function repositoryRoot(path: string) {
  if (!path.trim()) throw new Error('A local repository path is required');
  const root = await realpath(resolve(path));
  if (!(await stat(root)).isDirectory()) throw new Error('The repository path must be a directory');
  return root;
}

const exec = promisify(execFile);
async function git(root: string, args: string[], maxBuffer = 16 * 1024 * 1024, signal?: AbortSignal) {
  const { stdout } = await exec('git', ['-C', root, ...args], {
    encoding: 'buffer', maxBuffer, signal, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

export async function repositoryRevision(root: string) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  if (await realpath(top) !== root) throw new Error('Pass the root of the Git repository for a live world');
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString('ascii').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error('Expected a Git commit SHA');
  const changes = await git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (changes.length) throw new Error('The tracked working tree must match the Git commit before exploring');
  const tracked = (await git(root, ['ls-tree', '-r', '--name-only', '-z', commit])).toString('utf8').split('\0');
  return { commit, tracked: new Set(tracked) };
}

export async function readRevisionSource(root: string, commit: string, path: string, signal?: AbortSignal) {
  const source = await readRepositorySource(root, path);
  const bytes = await git(root, ['cat-file', 'blob', `${commit}:${source.path}`], maxSourceBytes, signal);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  if (text !== source.text) throw new Error(`Working file differs from the selected Git commit: ${source.path}`);
  return source;
}

export async function indexSources(root: string, limit = 4096) {
  const dirs = [''];
  const files: string[] = [];
  for (let index = 0; index < dirs.length && index < limit && files.length < limit; index++) {
    const dir = dirs[index];
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (excludedName(entry.name) || entry.isSymbolicLink()) continue;
      const path = slash(join(dir, entry.name));
      if (entry.isDirectory() && dirs.length < limit) dirs.push(path);
      if (entry.isFile() && (extensions.has(extname(entry.name).toLowerCase()) || /^(dockerfile|makefile)(\.|$)/i.test(basename(entry.name)))) files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

export async function readRepositorySource(root: string, path: string) {
  const normalized = slash(path);
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || normalized.includes('\0')
    || normalized.split('/').some(part => !part || part === '.' || part === '..' || excludedName(part))) {
    throw new Error('Expected an allowed repository-relative file path');
  }
  const absolute = await realpath(resolve(root, normalized));
  const canonical = slash(relative(root, absolute));
  if (!canonical || canonical === '..' || canonical.startsWith('../') || isAbsolute(canonical)
    || canonical.split('/').some(excludedName)) {
    throw new Error('The file resolves outside the allowed repository sources');
  }
  const file = await open(absolute, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSourceBytes) throw new Error('Expected a text source file up to 512 KiB');
    const bytes = await file.readFile();
    if (bytes.length > maxSourceBytes || bytes.includes(0)) throw new Error('Expected a text source file up to 512 KiB');
    return { path: canonical, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n') };
  } finally {
    await file.close();
  }
}
