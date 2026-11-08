import { z } from 'zod';
import type { BehaviorInput } from '../../../spacetime_db/client/index.ts';
import { behaviorKey, entityKey, entityKinds, relationKinds } from '../../../spacetime_db/src/contract.ts';
import type { ExplorationTask, WorldKnowledge, WorldUpdate } from '../database/interface.ts';
import { matchQuote } from './protocol.ts';
import { readRevisionSource } from './repository.ts';

const path = z.string().min(1).max(768);
const ref = z.strictObject({ kind: z.enum(entityKinds), path, symbol: z.string().trim().max(256) });
const citation = z.strictObject({ path, startLine: z.number().int().min(1), endLine: z.number().int().min(1), excerpt: z.string().min(1).max(2400) });
const event = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const value = z.string().max(2048);
const delay = z.number().int().min(0).max(3_600_000);
const schema = z.strictObject({
  entities: z.array(z.strictObject({ entity: ref, source: citation })).max(24),
  relations: z.array(z.strictObject({ from: ref, kind: z.enum(relationKinds), to: ref, source: citation })).max(32),
  behaviors: z.array(z.strictObject({
    entity: ref, name: z.string().trim().min(1).max(128), source: citation,
    rule: z.strictObject({
      event,
      when: z.array(z.strictObject({ key, equals: value })).max(12),
      set: z.array(z.strictObject({ key, value })).max(12),
      emit: z.array(z.strictObject({ target: ref.nullable(), event, delayMs: delay })).max(12),
      retry: z.strictObject({ delayMs: delay.min(1), maxAttempts: z.number().int().min(2).max(8) }).nullable(),
    }),
  })).max(16),
  tasks: z.array(z.strictObject({ path, question: z.string().trim().min(1).max(400) })).max(8),
});

export const worldOutputSchema = z.toJSONSchema(schema, { target: 'draft-7' });

function scalar(text: string) {
  const value: unknown = JSON.parse(text);
  if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !Number.isFinite(value)) {
    throw new Error('State values must be JSON scalars');
  }
  return JSON.stringify(value);
}

function userName(value: string) {
  if (value.startsWith('lattice.')) throw new Error('lattice.* is reserved for the database');
  return value;
}

export async function verifyWorldUpdate(
  root: string, commit: string, response: string, world: WorldKnowledge, signal: AbortSignal,
) {
  signal.throwIfAborted();
  const output = schema.parse(JSON.parse(response));
  const update: WorldUpdate = { entities: [], relations: [], behaviors: [], tasks: [] };
  const rejected: { kind: string; path: string; reason: string }[] = [];
  const sources = new Map<string, ReturnType<typeof readRevisionSource>>();
  const active = new Set(world.entities.filter(row => row.active).map(row => row.key));
  const inactive = new Set(world.entities.filter(row => !row.active).map(row => row.key));
  const knownBehaviors = new Map(world.behaviors.map(row => [behaviorKey(row.entity, row.name), row.rule]));
  function read(path: string) {
    let result = sources.get(path);
    if (!result) {
      result = readRevisionSource(root, commit, path, signal);
      sources.set(path, result);
    }
    return result;
  }
  async function entity(input: z.infer<typeof ref>) {
    const { path } = await read(input.path);
    if (path.length > 768 || (input.kind === 'file' ? input.symbol !== '' : !input.symbol)) throw new Error('Invalid canonical entity reference');
    return { ...input, path, key: entityKey(input.kind, path, input.symbol) };
  }
  async function endpoint(input: z.infer<typeof ref>) {
    const node = await entity(input);
    if (!active.has(node.key)) throw new Error(`Missing verified endpoint: ${node.path} ${node.symbol}`);
    return node.key;
  }
  async function cite(input: z.infer<typeof citation>) {
    const source = await read(input.path);
    if (source.path.length > 768) throw new Error('Source path exceeds the database limit');
    return { ...input, path: source.path, excerpt: matchQuote(source.text, input.startLine, input.endLine, input.excerpt) };
  }
  async function check(kind: string, path: string, run: () => Promise<void>) {
    signal.throwIfAborted();
    try {
      await run();
    } catch (error) {
      signal.throwIfAborted();
      rejected.push({ kind, path, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0] });
    }
  }

  for (const item of output.entities) await check('Entity', item.entity.path, async () => {
    const { key, ...node } = await entity(item.entity);
    if (inactive.has(key)) throw new Error('Entity was withdrawn from the world');
    update.entities.push({ ...node, source: await cite(item.source) });
    active.add(key);
  });
  for (const item of output.relations) await check('Relation', item.source.path, async () => {
    const [from, to, source] = await Promise.all([endpoint(item.from), endpoint(item.to), cite(item.source)]);
    update.relations.push({ from, to, kind: item.kind, source });
  });
  for (const item of output.behaviors) await check('Behavior', item.source.path, async () => {
    const owner = await endpoint(item.entity);
    if (!item.rule.set.length && !item.rule.emit.length) throw new Error('Behavior needs an executable effect');
    const rule: BehaviorInput['rule'] = {
      event: item.rule.event,
      when: item.rule.when.map(row => ({ key: userName(row.key), equals: scalar(row.equals) })),
      set: item.rule.set.map(row => ({ key: userName(row.key), value: scalar(row.value) })),
      emit: await Promise.all(item.rule.emit.map(async row => ({
        target: row.target ? await endpoint(row.target) : undefined, event: userName(row.event), delayMs: row.delayMs,
      }))),
      retry: item.rule.retry ?? undefined,
    };
    const key = behaviorKey(owner, item.name);
    const known = knownBehaviors.get(key);
    if (known && JSON.stringify(known) !== JSON.stringify(rule)) throw new Error('Existing behavior has a conflicting definition');
    update.behaviors.push({ entity: owner, name: item.name, rule, source: await cite(item.source) });
    knownBehaviors.set(key, rule);
  });
  for (const item of output.tasks) await check('Frontier', item.path, async () => {
    const { path } = await read(item.path);
    if (path.length > 768) throw new Error('Task path exceeds the database limit');
    update.tasks.push({ path, question: item.question });
  });
  signal.throwIfAborted();
  const proposed = `${output.entities.length} entities, ${output.relations.length} relations, ${output.behaviors.length} behaviors, ${output.tasks.length} follow-ups`;
  return { update, rejected, proposed };
}

export function worldContextFor(task: ExplorationTask, world: WorldKnowledge) {
  const module = task.path.split('/')[0];
  const direct = world.entities.filter(row => row.path === task.path
    || (row.kind === 'service' && row.path.startsWith(`${module}/`)));
  const ids = new Set(direct.map(row => row.id));
  const relations = world.relations.filter(row => ids.has(row.from) || ids.has(row.to)).slice(0, 24);
  for (const row of relations) { ids.add(row.from); ids.add(row.to); }
  const directIds = new Set(direct.map(row => row.id));
  const entities = [...direct, ...world.entities.filter(row => !directIds.has(row.id) && ids.has(row.id))].slice(0, 24);
  const keys = new Set(entities.map(row => row.key));
  const behaviors = world.behaviors.filter(row => keys.has(row.entity)).slice(0, 12);
  const subjects = new Set([...entities, ...relations, ...behaviors].map(row => row.id));
  const frontier = [...world.frontier.filter(row => row.path === task.path), ...world.frontier.filter(row => row.path !== task.path && row.status !== 'done')];
  return {
    entities, relations, behaviors,
    evidence: world.evidence.filter(row => subjects.has(row.subjectId)).slice(-16)
      .map(({ subjectId, verdict, source }) => ({ subjectId, verdict, path: source.path, startLine: source.startLine, endLine: source.endLine })),
    frontier: frontier.slice(0, 24).map(({ path, question, status }) => ({ path, question, status })),
  };
}
