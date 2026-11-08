import { entityKey } from '../../../spacetime_db/src/contract.ts';
import type { Citation, EntityInput } from '../../../spacetime_db/client/index.ts';
import type { WorldKnowledge, WorldUpdate } from '../database/interface.ts';
import { verifiedServiceEntry } from './entrypoint.ts';
import { readRevisionSource } from './repository.ts';

type Source = { path: string; text: string };

/** Matches a URL resolved from a literal service name and used directly in the next RestTemplate call. */
function directCalls(source: Source) {
  if (!source.text.includes('import org.springframework.web.client.RestTemplate;')) return [];
  const original = source.text.split('\n');
  const lines = source.text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
    .split('\n').map(line => line.trimStart().startsWith('//') ? '' : line);
  const calls = new Map<string, Citation>();
  for (let i = 0; i < lines.length; i++) {
    const definition = /^\s*(?:final\s+)?String\s+([a-zA-Z_$][\w$]*)\s*=\s*getServiceUrl\(\s*"([a-z0-9.-]+)"\s*\)\s*;\s*$/.exec(lines[i]);
    if (!definition || calls.has(definition[2])) continue;
    const next = lines.slice(i + 1, i + 6).join('\n');
    const invocation = /^[\s\w$<>,.?=\[\]]*?\brestTemplate\s*\.\s*(?:exchange|getForEntity|getForObject|postForEntity|postForObject|put|delete)\s*\(\s*([a-zA-Z_$][\w$]*)\s*(?:,|\+)/.exec(next);
    if (!invocation || invocation[1] !== definition[1]) continue;
    const endLine = i + 1 + invocation[0].split('\n').length;
    const excerpt = original.slice(i, endLine).join('\n');
    if (excerpt.length > 2400) continue;
    calls.set(definition[2], { path: source.path, startLine: i + 1, endLine, excerpt });
  }
  return [...calls];
}

export async function indexServiceEntry(
  root: string, commit: string, entry: Source, entries: ReadonlyMap<string, string>,
  world: WorldKnowledge, signal: AbortSignal,
): Promise<WorldUpdate | undefined> {
  const service = entry.path.split('/')[0];
  if (entries.get(service) !== entry.path) return;
  const verified = await verifiedServiceEntry(root, commit, entry, signal);
  if (!verified) return;
  const byKey = new Map(world.entities.map(row => [row.key, row]));
  const update: WorldUpdate = { entities: [], relations: [], behaviors: [], tasks: verified.followUp ? [verified.followUp] : [] };
  function ensureEntity(row: EntityInput) {
    const key = entityKey('service', row.path, row.symbol);
    const existing = byKey.get(key);
    if (existing && !existing.active) return undefined;
    if (!existing) update.entities.push(row);
    return key;
  }
  const from = ensureEntity(verified.entity);
  if (!from || !verified.implementation) return update;
  for (const [target, source] of directCalls(verified.implementation).slice(0, 24)) {
    const targetPath = entries.get(target);
    if (!targetPath || target === service) continue;
    const targetKey = entityKey('service', targetPath, target);
    const existing = byKey.get(targetKey);
    let to = existing?.active ? targetKey : undefined;
    if (!existing) {
      let targetEntry: Source;
      try {
        targetEntry = await readRevisionSource(root, commit, targetPath, signal);
      } catch {
        signal.throwIfAborted();
        continue;
      }
      const endpoint = await verifiedServiceEntry(root, commit, targetEntry, signal, false);
      if (endpoint) to = ensureEntity(endpoint.entity);
    }
    if (to) update.relations.push({ from, to, kind: 'calls', source });
  }
  return update;
}

export function numberedSourceExcerpt(text: string) {
  const lines = text.split('\n');
  const hits = lines.flatMap((line, index) =>
    index >= 40 && /\b(?:getServiceUrl|restTemplate|webClient|httpClient)\s*[.(]|@FeignClient\b/.test(line) ? [index] : []);
  const selected = new Set<number>();
  const add = (start: number, end: number) => {
    for (let index = Math.max(0, start); index < Math.min(end, lines.length); index++) selected.add(index);
  };
  add(0, hits.length ? 40 : 160);
  const sampleCount = Math.min(hits.length, 12);
  for (let i = 0; i < sampleCount; i++) {
    const hit = hits[Math.floor(i * hits.length / sampleCount)];
    add(hit - 3, hit + 7);
  }
  return [...selected].sort((a, b) => a - b).map(index => `${index + 1}: ${lines[index].slice(0, 180)}`).join('\n').slice(0, 12_000);
}
