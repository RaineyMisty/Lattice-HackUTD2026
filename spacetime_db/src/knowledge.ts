import { ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import { behaviorKey, entityKey, entityKinds, keyOf, relationKey, relationKinds } from './contract';
import {
  behaviorInput, citation, completion, db, entityInput, lease, relationInput, taskInput,
  type Citation, type Ctx, type Rule,
} from './schema';

const MAX_ATTEMPTS = 3;
const MAX_DELAY_MS = 3_600_000;
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SenderError(message);
}

export function identifier(value: string) {
  ensure(/^[a-z0-9][a-z0-9-]{0,62}$/.test(value), 'Invalid identifier');
  return value;
}

function bounded(text: string, max: number, field: string) {
  const value = text.trim();
  ensure(value.length > 0 && value.length <= max, `Invalid ${field}`);
  return value;
}

function sourcePath(path: string) {
  ensure(path.length <= 768 && !/[:\\\u0000-\u001f]/.test(path)
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), 'Invalid repository-relative path');
  return path;
}

export function worldRole(ctx: Ctx, worldId: string, roles: readonly string[]) {
  const world = ctx.db.world.id.find(worldId);
  const membership = ctx.db.member.id.find(keyOf(worldId, ctx.sender.toHexString()));
  ensure(world && membership && roles.includes(membership.role), 'World access denied');
  return world;
}

export function activeEntity(ctx: Ctx, worldId: string, key: string) {
  ensure(key.length <= 2400, 'Invalid entity key');
  const entity = ctx.db.entity.id.find(keyOf(worldId, key));
  ensure(entity?.active, 'Unknown or inactive entity');
  return entity;
}

export function eventName(value: string, allowSystem = false) {
  ensure(/^[a-z][a-z0-9_.-]{0,63}$/.test(value), 'Invalid event name');
  ensure(allowSystem || !value.startsWith('lattice.'), 'Reserved system event');
  return value;
}

function scalar(value: string) {
  ensure(value.length <= 2048, 'State value exceeds the size limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SenderError('State values must be JSON scalars');
  }
  ensure(parsed === null || typeof parsed === 'string' || typeof parsed === 'boolean' || Number.isFinite(parsed), 'State values must be JSON scalars');
  return JSON.stringify(parsed);
}

function property(key: string) {
  ensure(/^[a-z][a-z0-9_.-]{0,63}$/.test(key) && !key.startsWith('lattice.'), 'Invalid or reserved state key');
  return key;
}

function validateRule(ctx: Ctx, worldId: string, rule: Rule): Rule {
  ensure(rule.when.length <= 12 && rule.set.length <= 12 && rule.emit.length <= 12, 'Rule exceeds the action limit');
  ensure(rule.set.length + rule.emit.length > 0, 'Rule must change state or emit an event');
  if (rule.retry) {
    ensure(rule.retry.delayMs > 0 && rule.retry.delayMs <= MAX_DELAY_MS
      && rule.retry.maxAttempts >= 2 && rule.retry.maxAttempts <= 8, 'Invalid retry policy');
  }
  return {
    event: eventName(rule.event, true),
    when: rule.when.map(item => ({ key: property(item.key), equals: scalar(item.equals) })),
    set: rule.set.map(item => ({ key: property(item.key), value: scalar(item.value) })),
    emit: rule.emit.map(item => {
      if (item.target !== undefined) activeEntity(ctx, worldId, item.target);
      ensure(item.delayMs <= MAX_DELAY_MS, 'Event delay exceeds one hour');
      return { target: item.target, event: eventName(item.event), delayMs: item.delayMs };
    }),
    retry: rule.retry,
  };
}

function addEvidence(ctx: Ctx, worldId: string, commit: string, subjectId: string, subject: string, verdict: string, source: Citation) {
  sourcePath(source.path);
  ensure(source.startLine > 0 && source.endLine >= source.startLine && source.endLine - source.startLine < 100, 'Invalid source line range');
  bounded(source.excerpt, 4096, 'source excerpt');
  const duplicate = [...ctx.db.evidence.subjectId.filter(subjectId)].some(row =>
    row.subject === subject && row.author.equals(ctx.sender) && row.verdict === verdict
    && row.source.path === source.path && row.source.startLine === source.startLine
    && row.source.endLine === source.endLine && row.source.excerpt === source.excerpt);
  if (!duplicate) ctx.db.evidence.insert({ id: 0n, worldId, commit, subjectId, subject, verdict, source, author: ctx.sender });
}

function enqueueTask(ctx: Ctx, worldId: string, path: string, question: string) {
  path = sourcePath(path);
  question = bounded(question, 1024, 'task question');
  const id = keyOf(worldId, path, question);
  if (!ctx.db.frontier.id.find(id)) {
    ctx.db.frontier.insert({ id, worldId, path, question, status: 'queued', claimant: undefined, attempt: 0, deadline: undefined });
  }
}

export const init = db.init(ctx => {
  ctx.db.admin.insert({ identity: ctx.sender });
});

export const createWorld = db.reducer({ id: t.string(), repository: t.string(), commit: t.string() }, (ctx, args) => {
  ensure(ctx.db.admin.identity.find(ctx.sender), 'Only the database publisher can create worlds');
  const id = identifier(args.id);
  const repository = bounded(args.repository, 768, 'repository identifier');
  const commit = args.commit.toLowerCase();
  ensure(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit), 'Use a full Git commit SHA');
  ctx.db.world.insert({ id, repository, commit, owner: ctx.sender, createdAt: ctx.timestamp });
  ctx.db.member.insert({ id: keyOf(id, ctx.sender.toHexString()), worldId: id, identity: ctx.sender, role: 'owner' });
});

export const setMember = db.reducer({ worldId: t.string(), identity: t.identity(), role: t.string() }, (ctx, args) => {
  const world = worldRole(ctx, args.worldId, ['owner']);
  ensure(!world.owner.equals(args.identity), 'Cannot change the world owner');
  ensure(['reader', 'agent', 'operator', 'revoke'].includes(args.role), 'Invalid member role');
  const id = keyOf(args.worldId, args.identity.toHexString());
  const existing = ctx.db.member.id.find(id);
  if (args.role === 'revoke') {
    ctx.db.member.id.delete(id);
  } else if (existing) {
    ctx.db.member.id.update({ ...existing, role: args.role });
  } else {
    ctx.db.member.insert({ id, ...args });
  }
});

export const submitDiscovery = db.reducer({
  worldId: t.string(), entities: t.array(entityInput), relations: t.array(relationInput),
  behaviors: t.array(behaviorInput), tasks: t.array(taskInput), completes: t.option(completion),
}, (ctx, { worldId, entities, relations, behaviors, tasks, completes }) => {
  const world = worldRole(ctx, worldId, ['owner', 'agent']);
  ensure(entities.length + relations.length + behaviors.length + tasks.length <= 100, 'Batch exceeds 100 items');
  if (completes) {
    const task = ctx.db.frontier.id.find(completes.taskId);
    ensure(task?.worldId === worldId && task.claimant?.equals(ctx.sender) && task.attempt === completes.attempt, 'Task lease does not belong to this agent');
    if (task.status === 'done') return;
    ensure(task.status === 'leased' && task.deadline && task.deadline.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch, 'Task lease expired');
    ctx.db.frontier.id.update({ ...task, status: 'done', deadline: undefined });
  }
  for (const item of entities) {
    const kind = entityKinds.find(kind => kind === item.kind);
    ensure(kind, 'Unknown entity kind');
    const path = sourcePath(item.path);
    const symbol = item.symbol.trim();
    ensure(symbol.length <= 256 && (symbol.length > 0 || kind === 'file'), 'Use a stable qualified symbol for non-file entities');
    ensure(kind !== 'file' || symbol === '', 'File entities use an empty symbol');
    const key = entityKey(kind, path, symbol);
    const id = keyOf(worldId, key);
    if (!ctx.db.entity.id.find(id)) ctx.db.entity.insert({ id, worldId, key, kind, path, symbol, active: true });
    addEvidence(ctx, worldId, world.commit, id, 'entity', 'supports', item.source);
  }
  for (const item of relations) {
    const kind = relationKinds.find(kind => kind === item.kind);
    ensure(kind, 'Unknown relation kind');
    activeEntity(ctx, worldId, item.from);
    activeEntity(ctx, worldId, item.to);
    const id = keyOf(worldId, relationKey(item.from, kind, item.to));
    if (!ctx.db.relation.id.find(id)) ctx.db.relation.insert({ id, worldId, from: keyOf(worldId, item.from), to: keyOf(worldId, item.to), kind, active: true });
    addEvidence(ctx, worldId, world.commit, id, 'relation', 'supports', item.source);
  }
  for (const item of behaviors) {
    activeEntity(ctx, worldId, item.entity);
    const name = bounded(item.name, 128, 'rule name');
    const id = keyOf(worldId, behaviorKey(item.entity, name));
    const rule = validateRule(ctx, worldId, item.rule);
    const existing = ctx.db.behavior.id.find(id);
    ensure(!existing || JSON.stringify(existing.rule) === JSON.stringify(rule), 'Conflicting behavior. Review the rule or use a distinct name for the proposed replacement');
    const trigger = keyOf(worldId, item.entity, rule.event);
    if (!existing) {
      ensure([...ctx.db.behavior.trigger.filter(trigger)].length < 24, 'Too many rules for this trigger');
      ctx.db.behavior.insert({ id, worldId, entity: item.entity, name, trigger, rule, active: true });
    }
    addEvidence(ctx, worldId, world.commit, id, 'behavior', 'supports', item.source);
  }
  for (const task of tasks) enqueueTask(ctx, worldId, task.path, task.question);
});

function findSubject(ctx: Ctx, subject: string, id: string) {
  switch (subject) {
    case 'entity': return ctx.db.entity.id.find(id);
    case 'relation': return ctx.db.relation.id.find(id);
    case 'behavior': return ctx.db.behavior.id.find(id);
    default: throw new SenderError('Unknown subject type');
  }
}

export const reviewDiscovery = db.reducer({
  worldId: t.string(), subject: t.string(), id: t.string(), verdict: t.string(), source: citation,
}, (ctx, { worldId, subject, id, verdict, source }) => {
  const world = worldRole(ctx, worldId, ['owner', 'agent']);
  ensure(findSubject(ctx, subject, id)?.worldId === worldId, 'Unknown subject');
  ensure(verdict === 'supports' || verdict === 'contradicts', 'Invalid review verdict');
  addEvidence(ctx, worldId, world.commit, id, subject, verdict, source);
  if (verdict === 'contradicts') {
    enqueueTask(ctx, worldId, source.path, `Review conflicting ${subject} evidence at ${source.path}:${source.startLine}`);
  }
});

export const setDiscoveryActive = db.reducer({
  worldId: t.string(), subject: t.string(), id: t.string(), active: t.bool(),
}, (ctx, { worldId, subject, id, active }) => {
  worldRole(ctx, worldId, ['owner']);
  ensure(findSubject(ctx, subject, id)?.worldId === worldId, 'Unknown subject');
  switch (subject) {
    case 'entity': ctx.db.entity.id.update({ ...ctx.db.entity.id.find(id)!, active }); break;
    case 'relation': ctx.db.relation.id.update({ ...ctx.db.relation.id.find(id)!, active }); break;
    case 'behavior': ctx.db.behavior.id.update({ ...ctx.db.behavior.id.find(id)!, active }); break;
  }
});

export const claimTask = db.reducer({ worldId: t.string(), taskId: t.string(), leaseMs: t.u32() }, (ctx, args) => {
  worldRole(ctx, args.worldId, ['owner', 'agent']);
  ensure(args.leaseMs >= 100 && args.leaseMs <= MAX_DELAY_MS, 'Lease must be between 100 ms and one hour');
  const task = ctx.db.frontier.id.find(args.taskId);
  ensure(task?.worldId === args.worldId && task.status === 'queued', 'Task is no longer available');
  const attempt = task.attempt + 1;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(args.leaseMs) * 1000n;
  ctx.db.frontier.id.update({ ...task, status: 'leased', claimant: ctx.sender, attempt, deadline: new Timestamp(at) });
  ctx.db.lease.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at), taskId: task.id, attempt });
});

export const releaseExplorationTask = db.reducer({
  worldId: t.string(), taskId: t.string(), attempt: t.u8(), retry: t.bool(),
}, (ctx, args) => {
  worldRole(ctx, args.worldId, ['owner', 'agent']);
  const task = ctx.db.frontier.id.find(args.taskId);
  ensure(task?.worldId === args.worldId, 'Unknown exploration task');
  if (task.status !== 'leased' || task.attempt !== args.attempt) return;
  ensure(task.claimant?.equals(ctx.sender), 'Task lease does not belong to this agent');
  ctx.db.frontier.id.update({
    ...task, status: task.attempt >= 255 || (args.retry && task.attempt >= MAX_ATTEMPTS) ? 'dead' : 'queued',
    claimant: undefined, deadline: undefined,
  });
});

export const expireLease = db.reducer({ onSchedule: lease }, { arg: lease.rowType }, (ctx, { arg }) => {
  ensure(ctx.sender.equals(ctx.identity), 'Scheduler only');
  const task = ctx.db.frontier.id.find(arg.taskId);
  if (task?.status === 'leased' && task.attempt === arg.attempt) {
    ctx.db.frontier.id.update({
      ...task, status: task.attempt < MAX_ATTEMPTS ? 'queued' : 'dead', claimant: undefined, deadline: undefined,
    });
  }
});
