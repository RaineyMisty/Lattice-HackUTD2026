import { ScheduleAt, type Infer } from 'spacetimedb';
import { t } from 'spacetimedb/server';
import { keyOf } from './contract';
import { activeEntity, ensure, eventName, identifier, worldRole } from './knowledge';
import { db, eventJob, simulation, type Ctx } from './schema';

const MAX_EVENTS = 2048;
const MAX_DEPTH = 24;
const simulationRoles = ['owner', 'agent', 'operator'];
type Simulation = Infer<typeof simulation.rowType>;
type Event = Pick<Infer<typeof eventJob.rowType>, 'simulationId' | 'entity' | 'event' | 'depth' | 'attempt'>;

function runningSimulation(ctx: Ctx, id: string) {
  const simulation = ctx.db.simulation.id.find(id);
  ensure(simulation, 'Unknown simulation');
  worldRole(ctx, simulation.worldId, simulationRoles);
  ensure(simulation.status === 'running', 'Simulation is stopped');
  return simulation;
}

function enqueue(ctx: Ctx, event: Event, delayMs: number) {
  const simulation = ctx.db.simulation.id.find(event.simulationId)!;
  if (event.depth > MAX_DEPTH || simulation.queued >= MAX_EVENTS) {
    ctx.db.simulation.id.update({ ...simulation, dropped: simulation.dropped + 1 });
    return;
  }
  ctx.db.simulation.id.update({ ...simulation, queued: simulation.queued + 1 });
  ctx.db.eventJob.insert({
    ...event, scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.max(1, delayMs)) * 1000n),
  });
}

function putState(ctx: Ctx, simulation: Simulation, entity: string, key: string, value: string) {
  const id = keyOf(simulation.id, entity, key);
  const row = { id, worldId: simulation.worldId, simulationId: simulation.id, entity, key, value, updatedAt: ctx.timestamp };
  const previous = ctx.db.state.id.find(id);
  if (!previous) ctx.db.state.insert(row);
  else if (previous.value !== value) ctx.db.state.id.update(row);
}

export const createSimulation = db.reducer({ worldId: t.string(), id: t.string(), label: t.string() }, (ctx, args) => {
  worldRole(ctx, args.worldId, simulationRoles);
  ensure(args.label.trim().length > 0 && args.label.length <= 128, 'Invalid simulation label');
  ctx.db.simulation.insert({
    ...args, id: identifier(args.id), status: 'running', queued: 0, processed: 0, dropped: 0,
    createdAt: ctx.timestamp, lastEntity: undefined, lastEvent: undefined, lastOutcome: undefined,
  });
});

export const stopSimulation = db.reducer({ id: t.string() }, (ctx, { id }) => {
  const simulation = runningSimulation(ctx, id);
  ctx.db.simulation.id.update({ ...simulation, status: 'stopped' });
  for (const job of [...ctx.db.eventJob.simulationId.filter(id)]) ctx.db.eventJob.scheduledId.delete(job.scheduledId);
});

export const requestEvent = db.reducer({
  simulationId: t.string(), entity: t.string(), event: t.string(), delayMs: t.u32(),
}, (ctx, { simulationId, entity, event, delayMs }) => {
  const simulation = runningSimulation(ctx, simulationId);
  activeEntity(ctx, simulation.worldId, entity);
  ensure(simulation.queued < MAX_EVENTS && delayMs <= 3_600_000, 'Simulation limit or delay exceeded');
  enqueue(ctx, { simulationId, entity, event: eventName(event), depth: 0, attempt: 1 }, delayMs);
});

export const setBug = db.reducer({ simulationId: t.string(), entity: t.string() }, (ctx, { simulationId, entity }) => {
  const simulation = runningSimulation(ctx, simulationId);
  const origin = activeEntity(ctx, simulation.worldId, entity);
  const stateKey = `lattice.impact:${entity}`;
  if (ctx.db.state.id.find(keyOf(simulationId, entity, stateKey))) return;

  type Hop = { key: string; id: string; level: number; via?: string; relation?: string };
  const queue: Hop[] = [{ key: entity, id: origin.id, level: 0 }];
  const seen = new Set([origin.id]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const incoming = [...ctx.db.relation.to.filter(current.id)].filter(row => row.kind !== 'data_flow');
    const outgoing = [...ctx.db.relation.from.filter(current.id)].filter(row => row.kind === 'data_flow');
    for (const relation of [...incoming, ...outgoing]) {
      if (!relation.active) continue;
      const nextId = relation.kind === 'data_flow' ? relation.to : relation.from;
      if (seen.has(nextId)) continue;
      const next = ctx.db.entity.id.find(nextId);
      if (!next?.active) continue;
      seen.add(nextId);
      queue.push({ key: next.key, id: next.id, level: current.level + 1, via: current.key, relation: relation.id });
      ensure(simulation.queued + queue.length <= MAX_EVENTS, 'Fault propagation exceeds the simulation event budget');
    }
  }
  ensure(simulation.queued + queue.length <= MAX_EVENTS, 'Simulation event budget exhausted');
  for (const hit of queue) {
    const event = hit.level === 0 ? 'lattice.fault' : 'lattice.impact';
    putState(ctx, simulation, hit.key, stateKey, JSON.stringify({
      origin: entity, level: hit.level, status: hit.level === 0 ? 'fault_origin' : 'potential_impact',
      via: hit.via, relation: hit.relation,
    }));
    enqueue(ctx, { simulationId, entity: hit.key, event, depth: 0, attempt: 1 }, 0);
  }
});

export const advanceEvent = db.reducer({ onSchedule: eventJob }, { arg: eventJob.rowType }, (ctx, { arg }) => {
  ensure(ctx.sender.equals(ctx.identity), 'Scheduler only');
  const simulation = ctx.db.simulation.id.find(arg.simulationId);
  if (simulation?.status !== 'running') return;
  const active = ctx.db.entity.id.find(keyOf(simulation.worldId, arg.entity))?.active;
  const trigger = keyOf(simulation.worldId, arg.entity, arg.event);
  const rules = active ? [...ctx.db.behavior.trigger.filter(trigger)].filter(row => row.active) : [];
  rules.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const ready = rules.filter(({ rule }) => rule.when.every(({ key, equals }) =>
    ctx.db.state.id.find(keyOf(simulation.id, arg.entity, key))?.value === equals));
  const retry = ready.length === 0
    ? rules.map(row => row.rule.retry).filter((policy): policy is NonNullable<typeof policy> =>
      policy !== undefined && arg.attempt < policy.maxAttempts)
      .sort((a, b) => a.delayMs - b.delayMs)[0]
    : undefined;
  const sequence = simulation.processed + 1;
  ctx.db.simulation.id.update({
    ...simulation, processed: sequence, lastEntity: arg.entity, lastEvent: arg.event,
    lastOutcome: ready.length ? 'applied' : retry ? 'retry_requested' : 'no_match',
  });
  if (retry) {
    enqueue(ctx, { simulationId: simulation.id, entity: arg.entity, event: arg.event, depth: arg.depth, attempt: arg.attempt + 1 }, retry.delayMs);
  }
  for (const { rule } of ready) {
    for (const assignment of rule.set) putState(ctx, simulation, arg.entity, assignment.key, assignment.value);
    for (const emission of rule.emit) {
      enqueue(ctx, {
        simulationId: simulation.id, entity: emission.target ?? arg.entity, event: emission.event,
        depth: arg.depth + 1, attempt: 1,
      }, emission.delayMs);
    }
  }
  ctx.db.worldSignal.insert({ simulationId: simulation.id, sequence, at: ctx.timestamp });
});
