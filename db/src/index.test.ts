import { expect, test } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import schema, * as moduleExports from './index';
import { syncRows } from './projections';
import { DEMO_SOURCES } from './domain/index';
import type { AgentId } from '../../shared/types/index';

let connection = 1n;
const principal = (subject: string) => TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://lattice.example.test', sub: subject }), new ConnectionId(connection++));
function fixture() {
  const db = createModuleTestHarness(schema, moduleExports);
  const admin = principal('admin');
  const agents = { A: principal('A'), B: principal('B'), C: principal('C'), D: principal('D') };
  db.clock.set(Timestamp.fromDate(new Date('2026-11-07T12:00:00.000Z')));
  db.withReducerTx(admin, ctx => moduleExports.init(ctx, {}));
  for (const id of ['A', 'B', 'C', 'D'] as AgentId[]) {
    const identity = db.viewContext(agents[id]).sender;
    db.withReducerTx(admin, ctx => moduleExports.register_agent(ctx, { identity, agentId: id }));
  }
  db.withReducerTx(admin, ctx => moduleExports.inject_incident(ctx, {}));
  const submit = (id: AgentId) => {
    const source = DEMO_SOURCES[['A', 'B', 'C', 'D'].indexOf(id)];
    const expectedEpoch = db.db.worldState.id.find('aster')!.epoch;
    db.withReducerTx(agents[id], ctx => moduleExports.submit_evidence(ctx, { sourceId: source.id, payloadJson: source.body, expectedEpoch }));
  };
  return { db, admin, agents, submit };
}

test('real reducers derive all classifications and three unique department notifications', () => {
  const { db, submit } = fixture();
  for (const id of ['D', 'A', 'B'] as AgentId[]) submit(id);
  expect(db.db.incidentTask.count()).toBe(0n);
  submit('C');
  expect(db.db.assetRisk.id.find('auth')?.status).toBe('direct');
  expect(db.db.assetRisk.id.find('checkout')?.status).toBe('downstream');
  expect(db.db.assetRisk.id.find('merchant')?.status).toBe('downstream');
  expect(db.db.assetRisk.id.find('reporting')?.status).toBe('unaffected');
  expect(db.db.incidentTask.count()).toBe(3n);
  expect(db.db.departmentNotification.count()).toBe(3n);
  const before = db.db.worldState.id.find('aster');
  submit('C');
  expect(db.db.worldState.id.find('aster')).toEqual(before);
});

test('source views and write permissions isolate agent identities', () => {
  const { db, admin, agents } = fixture();
  for (const id of ['A', 'B', 'C', 'D'] as AgentId[]) {
    const sources = moduleExports.my_sources(db.viewContext(agents[id]));
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(DEMO_SOURCES[['A', 'B', 'C', 'D'].indexOf(id)].id);
    expect(moduleExports.dashboard_world(db.viewContext(agents[id]))).toEqual([]);
    expect(() => db.withReducerTx(agents[id], ctx => moduleExports.reset_demo(ctx, {}))).toThrow();
    expect(() => db.withReducerTx(agents[id], ctx => moduleExports.stop_agents(ctx, {}))).toThrow();
  }
  expect(moduleExports.dashboard_world(db.viewContext(admin))).toHaveLength(1);
  expect(moduleExports.my_sources(db.viewContext(principal('stranger')))).toEqual([]);
  expect(() => db.withReducerTx(agents.A, ctx => moduleExports.submit_evidence(ctx, { sourceId: 'source-deployments', payloadJson: DEMO_SOURCES[2].body, expectedEpoch: 0 }))).toThrow();
  expect(db.db.evidence.count()).toBe(0n);
});

test('failed evidence rolls back transaction, including earlier writes', () => {
  const { db, agents } = fixture();
  const before = db.db.worldState.id.find('aster');
  expect(() => db.withReducerTx(agents.A, ctx => {
    moduleExports.update_agent_status(ctx, { status: 'reading', message: 'Investigating', expectedEpoch: 0 });
    moduleExports.submit_evidence(ctx, { sourceId: 'source-advisory', payloadJson: JSON.stringify({ ...JSON.parse(DEMO_SOURCES[0].body), finalRisk: 'direct' }), expectedEpoch: 0 });
  })).toThrow();
  expect(db.db.worldState.id.find('aster')).toEqual(before);
  expect(db.db.evidence.count()).toBe(0n);
});

test('stopping agents preserves queryable world and rejects further evidence writes', () => {
  const { db, admin, agents, submit } = fixture();
  for (const id of ['A', 'B', 'C', 'D'] as AgentId[]) submit(id);
  const tasks = [...db.db.incidentTask.iter()];
  const notifications = [...db.db.departmentNotification.iter()];
  db.withReducerTx(agents.A, ctx => moduleExports.update_agent_status(ctx, { status: 'extracting', message: 'Checking again', expectedEpoch: 0 }));
  submit('A');
  expect(db.db.agentState.id.find('A')?.status).toBe('submitted');
  db.withReducerTx(admin, ctx => moduleExports.stop_agents(ctx, {}));
  expect([...db.db.incidentTask.iter()]).toEqual(tasks);
  expect([...db.db.departmentNotification.iter()]).toEqual(notifications);
  expect(() => submit('A')).toThrow('stopped');
  expect(db.db.assetRisk.count()).toBe(4n);
});

test('reset and resume revoke stale runs while snapshot revisions remain monotonic', () => {
  const { db, admin, agents } = fixture();
  const staleEvidence = { sourceId: 'source-advisory', payloadJson: DEMO_SOURCES[0].body, expectedEpoch: 0 };
  db.withReducerTx(admin, ctx => moduleExports.stop_agents(ctx, {}));
  db.withReducerTx(admin, ctx => moduleExports.resume_agents(ctx, {}));
  expect(() => db.withReducerTx(agents.A, ctx => moduleExports.submit_evidence(ctx, staleEvidence))).toThrow('expired');
  const beforeRevision = db.db.worldState.id.find('aster')!.revision;
  const beforeEpoch = db.db.worldState.id.find('aster')!.epoch;
  db.withReducerTx(admin, ctx => moduleExports.reset_demo(ctx, {}));
  expect(db.db.worldState.id.find('aster')!.revision).toBeGreaterThan(beforeRevision);
  db.withReducerTx(admin, ctx => moduleExports.inject_incident(ctx, {}));
  expect(() => db.withReducerTx(agents.A, ctx => moduleExports.submit_evidence(ctx, { ...staleEvidence, expectedEpoch: beforeEpoch }))).toThrow('expired');
  expect(() => db.withReducerTx(agents.A, ctx => moduleExports.update_agent_status(ctx, { status: 'reading', message: 'old run', expectedEpoch: beforeEpoch }))).toThrow('expired');
  expect(db.db.evidence.count()).toBe(0n);
});

test('projection synchronization performs zero writes for unchanged records, regardless of key order', () => {
  type Row = { id: string; message: string; createdAt: string };
  const rows = new Map<string, Row>([['one', { id: 'one', message: 'alert', createdAt: 'now' }]]);
  const writes: string[] = [];
  const table = { iter: () => rows.values(), insert: (row: Row) => { writes.push('insert'); rows.set(row.id, row); }, id: { update: (row: Row) => { writes.push('update'); rows.set(row.id, row); }, delete: (id: string) => { writes.push('delete'); rows.delete(id); } } };
  syncRows(table, [{ createdAt: 'now', message: 'alert', id: 'one' }]);
  expect(writes).toEqual([]);
  syncRows(table, [{ id: 'one', message: 'changed', createdAt: 'now' }, { id: 'two', message: 'new', createdAt: 'now' }]);
  expect(writes).toEqual(['update', 'insert']);
  syncRows(table, []);
  expect(writes).toEqual(['update', 'insert', 'delete', 'delete']);
});
