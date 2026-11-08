import { entityKey, entityKinds, relationKinds, type BehaviorInput, type Citation, type EntityInput } from '../../spacetime_db/client/index.ts';
import { emptyFindings, type AgentConnection, type Claim } from '../spacetimedb/client.ts';
import type { Tool } from './model.ts';
import type { Repository } from './repository.ts';

const text = { type: 'string' };
const integer = { type: 'integer' };
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: values });
const array = (items: object) => ({ type: 'array', items, maxItems: 12 });
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const source = object({ path: text, evidence: text, line: integer, endLine: integer }, ['line']);
function tool(name: string, description: string, parameters: object): Tool {
  return { type: 'function', function: { name, description, parameters } };
}

export const tools = [
  tool('list_files', 'List tracked files. Use a folder prefix or advance nextOffset.', object({ prefix: text, offset: integer }, [])),
  tool('search', 'Search for literal text in the pinned Git commit.', object({ query: text, prefix: text }, ['query'])),
  tool('read_file', 'Read numbered source. Cite its path and line number in publish_discovery.', object({ path: text, startLine: integer }, ['path'])),
  tool('find_entities', 'Find existing world entities by name or path and obtain their refs.', object({ query: text })),
  tool('publish_discovery', 'Publish immediately using source {path,line} from a preview or read_file. Return refs in the receipt. Keep batches small.', object({
    entities: array(object({ ref: text, kind: enumOf(entityKinds), symbol: text, source }, ['kind', 'source'])),
    relations: array(object({ from: text, to: text, kind: enumOf(relationKinds), source })),
    behaviors: array(object({
      entity: text, name: text, source,
      rule: object({
        event: text,
        when: array(object({ key: text, equals: text })),
        set: array(object({ key: text, value: text })),
        emit: array(object({ target: text, event: text, delayMs: integer }, ['event', 'delayMs'])),
        retry: object({ delayMs: integer, maxAttempts: integer }),
      }, ['event', 'when', 'set', 'emit']),
    })),
    tasks: array(object({ path: text, question: text })),
  }, [])),
  tool('finish_task', 'Finish this task. Outcome is inferred from publications when omitted. Reason is optional.', object({
    outcome: enumOf(['completed', 'no_findings']), reason: text,
  }, [])),
];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max: number, optional = false) {
  if (typeof value === 'string' && value.length <= max && (optional || value.trim())) return value;
  throw new Error('Invalid ' + field);
}

function items(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('Use at most 12 items per array');
  return value as unknown[];
}

export function explorationTools(repo: Pick<Repository, 'read' | 'list' | 'search' | 'files'>,
  db: Pick<AgentConnection, 'publish' | 'find'>, claim: Claim, signal: AbortSignal,
  log: (message: string) => void) {
  const evidence = new Map<string, { path: string; start: number; lines: string[] }>();
  type NodeInfo = Pick<EntityInput, 'kind' | 'path' | 'symbol'>;
  const refs = new Map<string, string>();
  const nodes = new Map<string, NodeInfo>();
  let generatedRef = 0;
  let published = false;

  function assignRef(known: Map<string, string>, key: string) {
    const existing = [...known].find(([, value]) => value === key)?.[0];
    if (existing) return existing;
    let ref: string;
    do { ref = '@' + ++generatedRef; } while (known.has(ref));
    return ref;
  }

  async function read(path: string, start: number) {
    const lines = await repo.read(path, signal);
    const slice = lines.slice(start - 1, start + 59);
    if (!slice.length) throw new Error('The starting line is outside the file');
    const id = 's' + (evidence.size + 1);
    evidence.set(id, { path, start, lines: slice });
    return { evidence: id, path, lines: slice.map((text, index) => [start + index, text.slice(0, 220)]),
      nextLine: start + slice.length <= lines.length ? start + slice.length : null };
  }

  function cite(input: unknown): Citation {
    const at = record(input);
    const start = Number(at.line ?? at.startLine);
    const end = Number(at.endLine ?? at.end ?? start);
    const path = typeof at.path === 'string' ? at.path.replaceAll('\\', '/') : undefined;
    const handle = typeof at.evidence === 'string' ? evidence.get(at.evidence) : undefined;
    const covers = (view: { path: string; start: number; lines: string[] }) =>
      (!path || view.path === path) && view.start <= start && end < view.start + view.lines.length;
    const view = handle && covers(handle) ? handle : path ? [...evidence.values()].find(covers) : undefined;
    if (!view || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= 40) {
      throw new Error('Cite source {path,line} from the assigned preview or read_file');
    }
    const excerpt = view.lines.slice(start - view.start, end - view.start + 1).join('\n').trim().slice(0, 2400);
    if (!excerpt) throw new Error('Cite a nonempty source line');
    return { path: view.path, startLine: start, endLine: end, excerpt };
  }

  async function publish(input: Record<string, unknown>) {
    const findings = emptyFindings();
    const batchRefs = new Map(refs);
    const batchNodes = new Map(nodes);
    const acceptedRefs: (NodeInfo & { ref: string })[] = [];
    const rejected: string[] = [];
    function batchItems(value: unknown, kind: string): unknown[] {
      if (value == null) return [];
      if (Array.isArray(value)) {
        if (value.length > 12) rejected.push(kind + ': publish remaining items in a separate batch');
        return value.slice(0, 12);
      }
      if (typeof value === 'object') return [value];
      rejected.push(kind + ': expected an object or array');
      return [];
    }
    const capture = (kind: string, run: () => void) => {
      try { run(); } catch (error) { rejected.push(kind + ': ' + (error instanceof Error ? error.message : String(error))); }
    };
    const endpoint = (value: unknown) => {
      const ref = string(value, 'entity ref', 768).replaceAll('\\', '/');
      const key = batchRefs.get(ref);
      if (key) return key;
      const matches = [...batchNodes].filter(([key, node]) => key === ref || node.path === ref || node.symbol === ref
        || (node.kind === 'service' && (ref === 'svc:' + node.symbol || ref === 'service:' + node.symbol)));
      if (matches.length === 1) return matches[0][0];
      throw new Error('Unknown or ambiguous ref ' + ref + '. Use a ref from publish_discovery or find_entities.');
    };

    for (const value of batchItems(input.entities, 'entities')) capture('entity', () => {
      const row = record(value);
      const kind = entityKinds.find(kind => kind === row.kind);
      if (!kind) throw new Error('Unknown entity kind');
      const symbol = kind === 'file' ? '' : string(row.symbol ?? row.name, 'symbol', 256).trim();
      const source = cite(row.source ?? row);
      const key = entityKey(kind, source.path, symbol);
      const ref = typeof row.ref === 'string' && row.ref.trim() ? string(row.ref, 'entity ref', 768).trim() : assignRef(batchRefs, key);
      if (batchRefs.has(ref) && batchRefs.get(ref) !== key) throw new Error('Entity ref already refers to a different node');
      const node = { kind, path: source.path, symbol };
      batchRefs.set(ref, key);
      batchNodes.set(key, node);
      acceptedRefs.push({ ref, ...node });
      findings.entities.push({ ...node, source });
    });
    for (const value of batchItems(input.relations, 'relations')) capture('relation', () => {
      const row = record(value);
      const kind = relationKinds.find(kind => kind === row.kind);
      if (!kind) throw new Error('Unknown relation kind');
      findings.relations.push({ from: endpoint(row.from), to: endpoint(row.to), kind, source: cite(row.source) });
    });
    for (const value of batchItems(input.tasks, 'tasks')) capture('task', () => {
      const row = record(value);
      const path = string(row.path, 'task path', 768).replaceAll('\\', '/');
      if (!repo.files.has(path)) throw new Error('Queue a tracked source file');
      findings.tasks.push({ path, question: string(row.question, 'task question', 400).trim() });
    });
    signal.throwIfAborted();
    if (findings.entities.length || findings.relations.length || findings.tasks.length) {
      await db.publish(findings, claim);
      for (const [ref, key] of batchRefs) refs.set(ref, key);
      for (const [key, node] of batchNodes) nodes.set(key, node);
      published = true;
    }
    let behaviors = 0;
    for (const value of batchItems(input.behaviors, 'behaviors')) {
      signal.throwIfAborted();
      try {
        const row = record(value);
        const rule = record(row.rule);
        const inputRule: BehaviorInput['rule'] = {
          event: string(rule.event, 'behavior event', 64),
          when: items(rule.when).map(value => {
            const condition = record(value);
            return { key: string(condition.key, 'state key', 64), equals: string(condition.equals, 'state JSON', 2048) };
          }),
          set: items(rule.set).map(value => {
            const assignment = record(value);
            return { key: string(assignment.key, 'state key', 64), value: string(assignment.value, 'state JSON', 2048) };
          }),
          emit: items(rule.emit).map(value => {
            const action = record(value);
            return { target: action.target == null ? undefined : endpoint(action.target), event: string(action.event, 'event', 64),
              delayMs: Number(action.delayMs) };
          }),
          retry: rule.retry == null ? undefined : { delayMs: Number(record(rule.retry).delayMs), maxAttempts: Number(record(rule.retry).maxAttempts) },
        };
        await db.publish({ ...emptyFindings(), behaviors: [{
          entity: endpoint(row.entity), name: string(row.name, 'behavior name', 128), source: cite(row.source), rule: inputRule,
        }] }, claim);
        behaviors++;
        published = true;
      } catch (error) { rejected.push('behavior: ' + (error instanceof Error ? error.message : String(error))); }
    }
    const receipt = { entities: findings.entities.length, relations: findings.relations.length, behaviors,
      tasks: findings.tasks.length, refs: acceptedRefs, rejected };
    if (receipt.entities || receipt.relations || receipt.behaviors || receipt.tasks) {
      log('Published ' + receipt.entities + ' nodes, ' + receipt.relations + ' edges, ' + behaviors + ' behaviors, ' + receipt.tasks + ' tasks');
    }
    for (const reason of rejected) log('Rejected ' + reason.slice(0, 180));
    return receipt;
  }

  return {
    read,
    async call(name: string, json: string): Promise<{ result: unknown; finished?: string; failed?: boolean }> {
      const args = record(JSON.parse(json));
      const prefix = string(args.prefix ?? '', 'prefix', 768, true);
      const offset = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value)
        ? Math.max(fallback, value) : fallback;
      switch (name) {
        case 'list_files': return { result: repo.list(prefix, offset(args.offset, 0)) };
        case 'search': {
          const query = string(args.query, 'search query', 120);
          if (/[\r\n\0]/.test(query)) throw new Error('Search for one line of literal text');
          return { result: await repo.search(query, prefix, signal) };
        }
        case 'read_file': return { result: await read(string(args.path, 'path', 768).replaceAll('\\', '/'), offset(args.startLine, 1)) };
        case 'find_entities': return { result: db.find(string(args.query, 'entity query', 120)).map(row => {
          const ref = assignRef(refs, row.key);
          refs.set(ref, row.key);
          nodes.set(row.key, row);
          return { ref, kind: row.kind, symbol: row.symbol, path: row.path };
        }) };
        case 'publish_discovery': {
          const receipt = await publish(args);
          const failed = receipt.rejected.length > 0 && !(receipt.entities || receipt.relations || receipt.behaviors || receipt.tasks);
          return { result: receipt, failed };
        }
        case 'finish_task': {
          const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 320) : '';
          if (published) return { result: 'completed', finished: reason || 'Completed after publishing' };
          if (evidence.size) return { result: 'no_findings', finished: reason ? 'No findings — ' + reason : 'No findings after reading source' };
          throw new Error('Read source before finishing without findings');
        }
        default: throw new Error('Unknown exploration tool');
      }
    },
  };
}
