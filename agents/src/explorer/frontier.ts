import type { ExplorationTask } from '../database/interface.ts';
import { isSourcePath, readRepositorySource, stableId } from './repository.ts';

const question = 'Survey the repository using read-only tools. Use this file as a starting clue, choose a connected area to explore, and propose concrete files to investigate next.';

export function prioritizeSeeds(paths: string[]) {
  const safe = paths.filter(path => !/(?:^|[-_.])(?:secret|credentials)(?:[-_.]|$)/i.test(path.split('/').at(-1) ?? ''));
  const application = safe.filter(path => isSourcePath(path) && !/(?:^|\/)(?:[^/]*docs|tests?|fixtures?|examples?|hack|scripts?)(?:\/|$)/i.test(path));
  if (!application.length) return safe;
  const entries = application.filter(path => /(?:^|\/)(?:main\.[^/]+|app\.[^/]+|server\.[^/]+|[^/]+Application\.[^/]+|(?:docker-)?compose\.ya?ml)$/i.test(path));
  return [...new Set([...entries, ...application])];
}

export async function seedFrontier(root: string, paths: readonly string[], limit: number): Promise<ExplorationTask[]> {
  const tasks: ExplorationTask[] = [];
  for (const path of paths) {
    if (tasks.length === limit) break;
    if (!path || path.length > 768) continue;
    const source = await readRepositorySource(root, path).catch(() => undefined);
    if (source?.path !== path) continue;
    tasks.push({ id: stableId('frontier-seed', path), path, question });
  }
  return tasks;
}
