import { posix } from 'node:path';
import type { EntityInput, TaskInput } from '../../../spacetime_db/client/index.ts';
import { readRevisionSource } from './repository.ts';

const entryPattern = /^([a-z0-9][a-z0-9.-]*)\/src\/main\/java\/(?:[^/]+\/)*([A-Za-z][\w]*)Application\.java$/;

export function serviceEntryPaths(tracked: ReadonlySet<string>) {
  const entries = new Map<string, string>();
  for (const path of tracked) {
    const match = entryPattern.exec(path);
    if (match && tracked.has(`${match[1]}/pom.xml`) && !entries.has(match[1])) entries.set(match[1], path);
  }
  return entries;
}

export async function verifiedServiceEntry(
  root: string, commit: string, entry: { path: string; text: string }, signal: AbortSignal, includeImplementation = true,
): Promise<{ entity: EntityInput; followUp?: TaskInput; implementation?: { path: string; text: string } } | undefined> {
  const match = entryPattern.exec(entry.path);
  if (!match || !entry.text.includes('import org.springframework.boot.autoconfigure.SpringBootApplication;')) return;
  const [, module, name] = match;
  const lines = entry.text.split('\n');
  const annotation = lines.findIndex(line => /^\s*@SpringBootApplication\b/.test(line));
  if (annotation < 0) return;
  const read = async (path: string) => {
    try {
      return await readRevisionSource(root, commit, path, signal);
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  const manifest = await read(`${module}/pom.xml`);
  if (!manifest) return;
  const project = manifest.text.replace(/<!--[\s\S]*?-->/g, '').replace(/<parent\b[^>]*>[\s\S]*?<\/parent>/, '')
    .split(/<(?:dependencies|dependencyManagement|build|profiles|properties)\b/, 1)[0];
  if (project.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1] !== module) return;

  const impl = includeImplementation
    ? await read(posix.join(posix.dirname(entry.path), 'service', `${name}ServiceImpl.java`))
    : undefined;
  const entity: EntityInput = {
    kind: 'service', path: entry.path, symbol: module,
    source: { path: entry.path, startLine: annotation + 1, endLine: annotation + 1, excerpt: lines[annotation].trim() },
  };
  return {
    entity,
    implementation: impl,
    followUp: impl && {
      path: impl.path,
      question: `Trace one concrete cross-service call or executable behavior for ${module}; cite its implementation.`,
    },
  };
}
