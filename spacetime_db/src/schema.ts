import { schema, table, t, type ReducerCtx } from 'spacetimedb/server';
import type { Infer } from 'spacetimedb';

const stringIndex = () => t.string().index('btree');
const id = () => t.string().primaryKey();

export const citation = t.object('Citation', {
  path: t.string(), startLine: t.u32(), endLine: t.u32(), excerpt: t.string(),
});
export const entityInput = t.object('EntityInput', {
  kind: t.string(), path: t.string(), symbol: t.string(), source: citation,
});
export const relationInput = t.object('RelationInput', {
  from: t.string(), kind: t.string(), to: t.string(), source: citation,
});
const condition = t.object('Condition', { key: t.string(), equals: t.string() });
const assignment = t.object('Assignment', { key: t.string(), value: t.string() });
const emission = t.object('Emission', {
  target: t.option(t.string()), event: t.string(), delayMs: t.u32(),
});
const retry = t.object('Retry', { delayMs: t.u32(), maxAttempts: t.u8() });
export const rule = t.object('Rule', {
  event: t.string(), when: t.array(condition), set: t.array(assignment),
  emit: t.array(emission), retry: t.option(retry),
});
export const behaviorInput = t.object('BehaviorInput', {
  entity: t.string(), name: t.string(), rule, source: citation,
});
export const taskInput = t.object('TaskInput', { path: t.string(), question: t.string() });
export const completion = t.object('Completion', { taskId: t.string(), attempt: t.u8() });

export const admin = table({ name: 'module_admin' }, { identity: t.identity().primaryKey() });
export const world = table({ name: 'repository_world' }, {
  id: id(), repository: t.string(), commit: t.string(), owner: t.identity(), createdAt: t.timestamp(),
});
export const member = table({ name: 'world_member' }, {
  id: id(), worldId: stringIndex(), identity: t.identity().index('btree'), role: t.string(),
});
export const entity = table({ name: 'entity' }, {
  id: id(), worldId: stringIndex(), key: t.string(), kind: t.string(), path: t.string(),
  symbol: t.string(), active: t.bool(),
});
export const relation = table({ name: 'relation' }, {
  id: id(), worldId: stringIndex(), from: stringIndex(), kind: t.string(), to: stringIndex(), active: t.bool(),
});
export const behavior = table({ name: 'behavior' }, {
  id: id(), worldId: stringIndex(), entity: t.string(), name: t.string(), trigger: stringIndex(),
  rule, active: t.bool(),
});
export const evidence = table({ name: 'evidence' }, {
  id: t.u64().primaryKey().autoInc(), worldId: stringIndex(), subjectId: stringIndex(),
  subject: t.string(), author: t.identity(), verdict: t.string(), commit: t.string(), source: citation,
});
export const frontier = table({ name: 'frontier' }, {
  id: id(), worldId: stringIndex(), path: t.string(), question: t.string(), status: t.string(),
  claimant: t.option(t.identity()), attempt: t.u8(), deadline: t.option(t.timestamp()),
});
export const simulation = table({ name: 'simulation' }, {
  id: id(), worldId: stringIndex(), label: t.string(), status: t.string(),
  queued: t.u32(), processed: t.u32(), dropped: t.u32(), createdAt: t.timestamp(),
  lastEntity: t.option(t.string()), lastEvent: t.option(t.string()), lastOutcome: t.option(t.string()),
});
export const state = table({ name: 'entity_state' }, {
  id: id(), worldId: stringIndex(), simulationId: stringIndex(), entity: t.string(), key: t.string(),
  value: t.string(), updatedAt: t.timestamp(),
});
export const lease = table({ name: 'lease_schedule' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(),
  taskId: t.string(), attempt: t.u8(),
});
export const eventJob = table({ name: 'event_schedule' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(),
  simulationId: stringIndex(), entity: t.string(), event: t.string(),
  depth: t.u8(), attempt: t.u8(),
});
// This public signal contains no repository, source, or event payload. The
// corresponding state and simulation views enforce world membership.
export const worldSignal = table({ name: 'world_signal', public: true, event: true }, {
  simulationId: t.string(), sequence: t.u32(), at: t.timestamp(),
});

export const db = schema({
  admin, world, member, entity, relation, behavior, evidence, frontier, simulation,
  state, lease, eventJob, worldSignal,
});
export type Ctx = ReducerCtx<typeof db.schemaType>;
export type Rule = Infer<typeof rule>;
export type Citation = Infer<typeof citation>;
