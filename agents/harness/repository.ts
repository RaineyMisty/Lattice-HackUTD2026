import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const maxSourceBytes = 512 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

async function git(root: string, args: string[], signal?: AbortSignal, maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await exec('git', ['-C', root, ...args], {
    encoding: 'buffer', maxBuffer, signal, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

function safePath(path: string) {
  return !!path && path.length <= 768 && !/[:\\\x00-\x1f]/.test(path)
    && path.split('/').every(part => part && !/^(?:\.{1,2}|\.git|node_modules|vendor|dist|target|build|coverage)$/i.test(part)
      && !/^\.env(?:\.|$)/i.test(part) && !/\.(?:pem|key|pfx|p12)$/i.test(part)
      && !/(?:^|[-_.])(?:secret|credentials)(?:[-_.]|$)/i.test(part));
}

export const repositoryRoot = (path: string) => realpath(resolve(path));

export async function repositoryHead(root: string) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim();
  if (await realpath(top) !== root) throw new Error('Choose the root of a Git checkout');
  const commit = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid Git commit');
  return commit;
}

export async function repositoryRevision(root: string) {
  const commit = await repositoryHead(root);
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).length) {
    throw new Error('Commit or restore tracked changes before exploring');
  }
  return { commit };
}

const code = /\.(?:[cm]?[jt]sx?|py|java|kts?|go|rs|rb|php|cs|fs|cpp|cc|c|h|hpp|swift|scala|exs?|dart|vue|svelte|sql|proto|sh|ya?ml|json|toml|xml|properties|gradle|html|tf|graphql)$/i;
const entry = /(?:^|\/)(?:main\.[^/]+|app\.[^/]+|server\.[^/]+|[^/]+Application\.[^/]+|(?:docker-)?compose\.ya?ml|Dockerfile)$/i;

export class Repository {
  private constructor(readonly root: string, readonly commit: string, readonly files: ReadonlySet<string>) {}

  static async open(path: string) {
    const root = await repositoryRoot(path);
    const { commit } = await repositoryRevision(root);
    const tree = (await git(root, ['ls-tree', '-rz', commit])).toString('utf8');
    const paths = tree.split('\0').flatMap(row => {
      const path = row.slice(row.indexOf('\t') + 1);
      return /^100\d+ blob /.test(row) && safePath(path) ? [path] : [];
    });
    return new Repository(root, commit, new Set(paths));
  }

  candidates(seed: number) {
    const sources = [...this.files].filter(path => (code.test(path) || entry.test(path))
      && !/(?:^|\/)(?:[^/]*docs|tests?|fixtures?|examples?|\.github)(?:\/|$)/i.test(path)
      && !/(?:^|[-.])lock\.\w+$/i.test(path));
    const paths = sources.length ? sources : [...this.files];
    let state = seed || 1;
    for (let index = paths.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const next = state % (index + 1);
      [paths[index], paths[next]] = [paths[next], paths[index]];
    }
    return paths.sort((a, b) => Number(entry.test(b)) - Number(entry.test(a)));
  }

  list(prefix: string, offset: number) {
    const paths = [...this.files].filter(path => !prefix || path === prefix || path.startsWith(prefix + '/'));
    return { paths: paths.slice(offset, offset + 60), nextOffset: offset + 60 < paths.length ? offset + 60 : null };
  }

  async read(path: string, signal: AbortSignal) {
    if (!this.files.has(path)) throw new Error('Choose a file listed in the pinned commit');
    const bytes = await git(this.root, ['cat-file', 'blob', this.commit + ':' + path], signal, maxSourceBytes)
      .catch(() => { signal.throwIfAborted(); throw new Error('This Git source file is unavailable or exceeds 512 KiB'); });
    if (bytes.includes(0)) throw new Error('Choose a UTF-8 source file');
    return decoder.decode(bytes).replaceAll('\r\n', '\n').split('\n');
  }

  async search(query: string, prefix: string, signal: AbortSignal) {
    const bytes = await git(this.root, ['grep', '-n', '-z', '-I', '-F', '-m', '2', '--no-color',
      '-e', query, this.commit, '--', ...(prefix ? [':(literal)' + prefix] : [])], signal, 1024 * 1024)
      .catch((error: { code?: number }) => {
        signal.throwIfAborted();
        if (error.code === 1) return Buffer.alloc(0);
        throw new Error('Search is too broad or unavailable. Try a narrower prefix.');
      });
    return bytes.toString('utf8').split('\n').flatMap(row => {
      const [file, line, text] = row.split('\0', 3);
      const path = file.slice(this.commit.length + 1);
      return this.files.has(path) && line && text !== undefined ? [{ path, line: Number(line), text: text.slice(0, 260) }] : [];
    }).slice(0, 24);
  }
}
