import { schema, table, t, SenderError, type ReducerCtx } from 'spacetimedb/server';
import { AGENT_SOURCE, createInitialWorld, injectIncident, submitEvidence } from './domain/index';
import type { AgentId, AgentState, EvidencePayload, WorldSnapshot } from '../../shared/types/index';
import { syncRows } from './projections';

// Raw material and evidence are private. Agents only receive their assigned
// document through my_sources. Derived public tables are read-only to clients.
const admin = table({ name: 'admin' }, { identity: t.identity().primaryKey() });
const operator = table({ name: 'operator' }, { identity: t.identity().primaryKey() });
const agentIdentity = table({ name: 'agent_identity' }, { identity: t.identity().primaryKey(), agentId: t.string().unique() });
const rawSource = table({ name: 'raw_source' }, { id: t.string().primaryKey(), kind: t.string().index('btree'), title: t.string(), body: t.string(), epoch: t.u32() });
const evidence = table({ name: 'evidence' }, { id: t.string().primaryKey(), agentId: t.string(), sourceId: t.string(), submittedAt: t.string(), payloadJson: t.string() });
const worldState = table({ name: 'world_state' }, { id: t.string().primaryKey(), revision: t.u32(), epoch: t.u32(), snapshotJson: t.string() });
const incident = table({ name: 'incident', public: true }, { id: t.string().primaryKey(), title: t.string(), severity: t.string(), injectedAt: t.string() });
const assetRisk = table({ name: 'asset_risk', public: true }, { id: t.string().primaryKey(), name: t.string(), status: t.string(), reason: t.string(), evidenceIdsJson: t.string(), impactPathJson: t.string(), detailsJson: t.string() });
const dependency = table({ name: 'dependency', public: true }, { id: t.string().primaryKey(), fromAsset: t.string(), toAsset: t.string(), kind: t.string() });
const incidentTask = table({ name: 'incident_task', public: true }, { id: t.string().primaryKey(), incidentId: t.string(), assetId: t.string(), department: t.string(), priority: t.string(), instruction: t.string(), reason: t.string(), detailsJson: t.string() });
const departmentNotification = table({ name: 'department_notification', public: true }, { id: t.string().primaryKey(), taskId: t.string(), department: t.string(), message: t.string(), createdAt: t.string() });
const agentState = table({ name: 'agent_state', public: true }, { id: t.string().primaryKey(), status: t.string(), message: t.string(), detailsJson: t.string() });

const spacetimedb = schema({ admin, operator, agentIdentity, rawSource, evidence, worldState, incident, assetRisk, dependency, incidentTask, departmentNotification, agentState });
export default spacetimedb;
type Context = ReducerCtx<typeof spacetimedb.schemaType>;

function requireAdmin(ctx: Context) {
  if (!ctx.db.admin.identity.find(ctx.sender)) throw new SenderError('Only the publishing administrator can register identities');
}
function requireOperator(ctx: Context) {
  if (!ctx.db.admin.identity.find(ctx.sender) && !ctx.db.operator.identity.find(ctx.sender)) throw new SenderError('An incident operator identity is required');
}
function agentFor(ctx: Context): AgentId {
  const row = ctx.db.agentIdentity.identity.find(ctx.sender);
  if (!row || !Object.hasOwn(AGENT_SOURCE, row.agentId)) throw new SenderError('Identity is not registered as an investigation agent');
  return row.agentId as AgentId;
}
function readWorld(ctx: Context): WorldSnapshot {
  const row = ctx.db.worldState.id.find('aster');
  if (!row) throw new SenderError('Database is not initialized');
  return JSON.parse(row.snapshotJson) as WorldSnapshot;
}
function now(ctx: Context) { return ctx.timestamp.toDate().toISOString(); }
function currentEpoch(ctx: Context) { return ctx.db.worldState.id.find('aster')?.epoch ?? 0; }
function requireEpoch(ctx: Context, expectedEpoch: number) {
  if (currentEpoch(ctx) !== expectedEpoch) throw new SenderError('Agent run expired. Read sources using a new run after reset or resume.');
}

/** Materialize the complete derived world in the SAME reducer transaction. */
function persist(ctx: Context, world: WorldSnapshot, epoch = currentEpoch(ctx)) {
  syncRows(ctx.db.rawSource, world.sources.map(row => ({ ...row, epoch })));
  syncRows(ctx.db.evidence, world.evidence.map(row => ({ id: row.id, agentId: row.agentId, sourceId: row.sourceId, submittedAt: row.submittedAt, payloadJson: JSON.stringify(row.payload) })));
  syncRows(ctx.db.incident, world.incident ? [world.incident] : []);
  syncRows(ctx.db.assetRisk, world.assets.map(row => ({ id: row.id, name: row.name, status: row.status, reason: row.reason, evidenceIdsJson: JSON.stringify(row.evidenceIds), impactPathJson: JSON.stringify(row.impactPath), detailsJson: JSON.stringify(row) })));
  syncRows(ctx.db.dependency, world.dependencies.map(row => ({ id: `${row.from}:${row.to}`, fromAsset: row.from, toAsset: row.to, kind: row.kind })));
  syncRows(ctx.db.incidentTask, world.tasks.map(row => ({ id: row.id, incidentId: row.incidentId, assetId: row.assetId, department: row.department, priority: row.priority, instruction: row.instruction, reason: row.reason, detailsJson: JSON.stringify(row) })));
  syncRows(ctx.db.departmentNotification, world.notifications);
  syncRows(ctx.db.agentState, world.agents.map(row => ({ id: row.id, status: row.status, message: row.message, detailsJson: JSON.stringify(row) })));
  const snapshot = { id: 'aster', revision: world.revision, epoch, snapshotJson: JSON.stringify(world) };
  if (ctx.db.worldState.id.find('aster')) ctx.db.worldState.id.update(snapshot);
  else ctx.db.worldState.insert(snapshot);
}

export const init = spacetimedb.init(ctx => {
  ctx.db.admin.insert({ identity: ctx.sender });
  persist(ctx, createInitialWorld());
});

export const register_agent = spacetimedb.reducer({ identity: t.identity(), agentId: t.string() }, (ctx, { identity, agentId }) => {
  requireAdmin(ctx);
  if (!Object.hasOwn(AGENT_SOURCE, agentId)) throw new SenderError('Expected agent A, B, C or D');
  if (ctx.db.operator.identity.find(identity) || ctx.db.admin.identity.find(identity)) throw new SenderError('Agent identities must be separate from operators');
  const existing = ctx.db.agentIdentity.agentId.find(agentId);
  if (existing && existing.identity.toHexString() !== identity.toHexString()) ctx.db.agentIdentity.identity.delete(existing.identity);
  if (ctx.db.agentIdentity.identity.find(identity)) ctx.db.agentIdentity.identity.update({ identity, agentId });
  else ctx.db.agentIdentity.insert({ identity, agentId });
});

export const register_operator = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireAdmin(ctx);
  if (ctx.db.agentIdentity.identity.find(identity)) throw new SenderError('Operators cannot use an agent identity');
  if (!ctx.db.operator.identity.find(identity)) ctx.db.operator.insert({ identity });
});

export const inject_incident = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
  persist(ctx, injectIncident(readWorld(ctx), now(ctx)));
});

export const submit_evidence = spacetimedb.reducer({ sourceId: t.string(), payloadJson: t.string(), expectedEpoch: t.u32() }, (ctx, { sourceId, payloadJson, expectedEpoch }) => {
  const agentId = agentFor(ctx);
  const world = readWorld(ctx);
  if (world.agentsStopped) throw new SenderError('Investigation agents have been stopped');
  requireEpoch(ctx, expectedEpoch);
  if (payloadJson.length > 32_768) throw new SenderError('Evidence exceeds 32 KiB');
  let payload: EvidencePayload;
  try { payload = JSON.parse(payloadJson) as EvidencePayload; } catch { throw new SenderError('Evidence must be valid JSON'); }
  try {
    // Rule A/B/C/D run here, on the database host, before transaction commit.
    // The caller supplies ownership facts, never final asset statuses, task
    // priorities, notification recipients or response-task records.
    const next = submitEvidence(world, agentId, sourceId, payload, now(ctx));
    if (next.revision !== world.revision) persist(ctx, next);
  } catch (error) { throw new SenderError(error instanceof Error ? error.message : 'Invalid evidence'); }
});

export const update_agent_status = spacetimedb.reducer({ status: t.string(), message: t.string(), expectedEpoch: t.u32() }, (ctx, { status, message, expectedEpoch }) => {
  const agentId = agentFor(ctx);
  requireEpoch(ctx, expectedEpoch);
  if (!['reading', 'extracting', 'error', 'stopped'].includes(status)) throw new SenderError('Agents cannot assert evidence submission or derived success');
  if (message.length > 300) throw new SenderError('Status message exceeds 300 characters');
  const world = readWorld(ctx);
  if (!world.incident || world.agentsStopped) throw new SenderError('No active investigation');
  world.revision++;
  world.agents = world.agents.map(row => row.id === agentId ? { ...row, status: status as AgentState['status'], message, updatedAt: now(ctx) } : row);
  persist(ctx, world);
});

export const stop_agents = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
  const world = readWorld(ctx); world.revision++; world.agentsStopped = true;
  world.agents = world.agents.map(row => ({ ...row, status: 'stopped', message: 'Stopped. Evidence remains in database.', updatedAt: now(ctx) }));
  persist(ctx, world, currentEpoch(ctx) + 1);
});
export const resume_agents = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
  const world = readWorld(ctx); world.revision++; world.agentsStopped = false;
  world.agents = world.agents.map(row => ({ ...row, status: row.evidenceCount ? 'submitted' : 'idle', message: row.evidenceCount ? 'Evidence already committed' : 'Ready for investigation' }));
  persist(ctx, world, currentEpoch(ctx) + 1);
});
export const reset_demo = spacetimedb.reducer(ctx => {
  requireOperator(ctx);
  const world = createInitialWorld();
  world.revision = readWorld(ctx).revision + 1;
  persist(ctx, world, currentEpoch(ctx) + 1);
});

// A caller cannot select another agent's raw source by changing SQL parameters.
export const my_sources = spacetimedb.view({ name: 'my_sources', public: true }, t.array(rawSource.rowType), ctx => {
  const assignment = ctx.db.agentIdentity.identity.find(ctx.sender);
  if (!assignment || !Object.hasOwn(AGENT_SOURCE, assignment.agentId)) return [];
  const snapshot = ctx.db.worldState.id.find('aster');
  if (!snapshot) return [];
  const world = JSON.parse(snapshot.snapshotJson) as WorldSnapshot;
  if (!world.incident || world.agentsStopped || world.evidence.some(row => row.agentId === assignment.agentId)) return [];
  return Array.from(ctx.db.rawSource.kind.filter(AGENT_SOURCE[assignment.agentId as AgentId]));
});

// Dashboard operators subscribe to one coherent committed snapshot; derived
// tables above are also directly queryable after every agent has disconnected.
export const dashboard_world = spacetimedb.view({ name: 'dashboard_world', public: true }, t.array(worldState.rowType), ctx => {
  if (!ctx.db.admin.identity.find(ctx.sender) && !ctx.db.operator.identity.find(ctx.sender)) return [];
  const row = ctx.db.worldState.id.find('aster');
  return row ? [row] : [];
});
