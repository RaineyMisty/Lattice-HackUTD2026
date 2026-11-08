import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { type DbConnection, entityKey, worldConnection, worldQueries } from '../client/index.ts';

const uri = process.env.LATTICE_STDB_URI ?? 'http://127.0.0.1:3380';
const database = process.env.LATTICE_STDB_DATABASE ?? 'lattice-world-local';

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const result = read();
    if (result !== undefined) return result;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('standalone world coordinates four agents and advances simulations through native schedules', { timeout: 75_000 }, async t => {
  const token = process.env.LATTICE_STDB_TEST_TOKEN;
  assert.ok(token, 'Set LATTICE_STDB_TEST_TOKEN to the disposable database publisher token');
  const connections = new Set<DbConnection>();
  t.after(() => { for (const connection of connections) connection.disconnect(); });
  const connect = (token?: string) => new Promise<DbConnection>((resolve, reject) => {
    const connection = worldConnection({ uri, database, token })
      .onConnect(connection => resolve(connection))
      .onConnectError((_context, error) => reject(error))
      .build();
    connections.add(connection);
  });
  const owner = await connect(token);
  const [agentA, agentB, agentC, agentD, outsider] = await Promise.all(Array.from({ length: 5 }, () => connect()));
  const agents = [agentA, agentB, agentC, agentD];
  const worldId = `world-${randomUUID()}`;
  const simulationId = `sim-${randomUUID()}`;
  const otherSimulation = `sim-${randomUUID()}`;
  const commit = 'a'.repeat(40);
  const source = { path: 'src/checkout.ts', startLine: 3, endLine: 3, excerpt: 'return pay(order);' };
  const checkout = entityKey('service', source.path, 'Checkout');
  const payment = entityKey('service', 'src/payment.ts', 'Payment');
  const frontend = entityKey('service', 'src/frontend.ts', 'Frontend');
  const reporting = entityKey('service', 'src/reporting.ts', 'Reporting');
  const empty = { worldId, entities: [], relations: [], behaviors: [], tasks: [], completes: undefined };

  function subscribe(connection: DbConnection) {
    return new Promise<void>((resolve, reject) => {
      connection.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(context => reject(context.event))
        .subscribe(worldQueries(worldId, simulationId));
    });
  }
  await Promise.all([subscribe(owner), subscribe(outsider)]);
  await owner.reducers.createWorld({ id: worldId, repository: 'test/living-repository', commit });
  assert.equal([...outsider.db.myWorlds.iter()].length, 0);
  await assert.rejects(outsider.reducers.submitDiscovery(empty), /access denied/i);
  await Promise.all(agents.map(agent => owner.reducers.setMember({ worldId, identity: agent.identity!, role: 'agent' })));
  await Promise.all(agents.map(subscribe));

  const discoveries = {
    ...empty,
    entities: [
      { kind: 'service', path: source.path, symbol: 'Checkout', source },
      { kind: 'service', path: 'src/payment.ts', symbol: 'Payment', source },
      { kind: 'service', path: 'src/frontend.ts', symbol: 'Frontend', source },
      { kind: 'service', path: 'src/reporting.ts', symbol: 'Reporting', source },
    ],
    relations: [
      { from: checkout, kind: 'calls', to: payment, source },
      { from: frontend, kind: 'depends_on', to: checkout, source },
      { from: payment, kind: 'calls', to: frontend, source },
    ],
    tasks: [{ path: 'src/payment.ts', question: 'Trace payment recovery' }],
  };
  await Promise.all(agents.map(agent => agent.reducers.submitDiscovery(discoveries)));
  await waitFor(() => owner.db.worldEvidence.count() === 28n ? true : undefined, 'four authors of evidence');
  assert.equal(owner.db.worldEntities.count(), 4n);
  assert.equal(owner.db.worldRelations.count(), 3n);
  assert.equal(owner.db.worldFrontier.count(), 1n);
  assert.equal(outsider.db.worldEntities.count(), 0n);
  assert.ok([...owner.db.worldEvidence.iter()].every(row => row.commit === commit));

  const task = [...owner.db.worldFrontier.iter()][0];
  const claim = { worldId, taskId: task.id, leaseMs: 900 };
  const claims = await Promise.allSettled(agents.map(agent => agent.reducers.claimTask(claim)));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const winner = claims.findIndex(result => result.status === 'fulfilled');
  const worker = agents[(winner + 1) % agents.length];
  await assert.rejects(worker.reducers.submitDiscovery({ ...empty, completes: { taskId: task.id, attempt: 1 } }), /lease/i);
  await waitFor(() => [...worker.db.worldFrontier.iter()].find(row => row.id === task.id && row.status === 'queued' && row.attempt === 1), 'lease timeout and requeue');
  await worker.reducers.claimTask({ ...claim, leaseMs: 5000 });
  await worker.reducers.submitDiscovery({
    ...empty, completes: { taskId: task.id, attempt: 2 },
    behaviors: [
      {
        entity: payment, name: 'on failure', source,
        rule: {
          event: 'lattice.fault', when: [], set: [{ key: 'mode', value: '"failed"' }], retry: undefined,
          emit: [{ target: checkout, event: 'recheck', delayMs: 0 }, { target: checkout, event: 'prepare', delayMs: 140 }],
        },
      },
      {
        entity: checkout, name: 'preparation', source,
        rule: {
          event: 'prepare', when: [], set: [{ key: 'ready', value: 'true' }], emit: [], retry: undefined,
        },
      },
      {
        entity: checkout, name: 'recheck', source,
        rule: {
          event: 'recheck', when: [{ key: 'ready', equals: 'true' }],
          set: [{ key: 'mode', value: '"recovered"' }], emit: [], retry: { delayMs: 250, maxAttempts: 3 },
        },
      },
    ],
  });
  const reviewed = [...owner.db.worldRelations.iter()].find(row => row.kind === 'depends_on')!;
  await agentC.reducers.reviewDiscovery({ worldId, subject: 'relation', id: reviewed.id, verdict: 'contradicts', source });
  await waitFor(() => owner.db.worldFrontier.count() === 2n ? true : undefined, 'review follow-up');
  assert.equal([...owner.db.worldFrontier.iter()].find(row => row.id === task.id)?.status, 'done');
  await assert.rejects(outsider.reducers.createSimulation({ worldId, id: otherSimulation, label: 'Denied' }), /access denied/i);
  await owner.reducers.createSimulation({ worldId, id: simulationId, label: 'Fault simulation' });
  await owner.reducers.createSimulation({ worldId, id: otherSimulation, label: 'Independent control' });

  const observed: number[] = [];
  owner.db.worldSignal.onInsert((_ctx, row) => observed.push(row.sequence));
  await agentD.reducers.setBug({ simulationId, entity: payment });
  await agentD.reducers.setBug({ simulationId, entity: payment });
  await assert.rejects(agentD.reducers.requestEvent({ simulationId, entity: payment, event: 'lattice.fault', delayMs: 0 }), /reserved/i);
  for (const agent of agents) {
    agent.disconnect();
    connections.delete(agent);
  }
  await waitFor(() => [...owner.db.worldStates.iter()].find(row => row.entity === checkout && row.key === 'mode' && row.value === '"recovered"'), 'scheduled recovery after all agents disconnected');
  const rows = [...owner.db.worldStates.iter()];
  assert.equal(rows.filter(row => row.simulationId === otherSimulation).length, 0);
  assert.equal(rows.some(row => row.entity === reporting), false);
  const impacts = rows.filter(row => row.key.startsWith('lattice.impact:'));
  assert.deepEqual(new Map(impacts.map(row => [row.entity, JSON.parse(row.value).level])), new Map([[payment, 0], [checkout, 1], [frontend, 2]]));
  assert.deepEqual(observed, [1, 2, 3, 4, 5, 6]);
  assert.equal(owner.db.worldSignal.count(), 0n);

  const reconnect = await connect(token);
  await subscribe(reconnect);
  assert.equal(reconnect.db.worldStates.count(), BigInt(rows.length));
  assert.equal(reconnect.db.worldSignal.count(), 0n);
  await owner.reducers.submitDiscovery({
    ...empty, behaviors: [
      { entity: reporting, name: 'delayed fault response', source, rule: {
        event: 'lattice.fault', when: [], set: [], retry: undefined,
        emit: [{ target: checkout, event: 'report-response', delayMs: 900 }],
      } },
      { entity: checkout, name: 'report response', source, rule: {
        event: 'report-response', when: [], emit: [], retry: undefined,
        set: [{ key: 'report-response', value: 'true' }],
      } },
    ],
  });
  await owner.reducers.setBug({ simulationId, entity: reporting });
  await waitFor(() => [...owner.db.worldSimulations.iter()].find(row =>
    row.id === simulationId && row.lastEntity === reporting && row.lastOutcome === 'applied'), 'report fault scheduled its follow-up');
  await assert.rejects(outsider.reducers.clearBug({ simulationId, entity: payment }), /access denied/i);
  await owner.reducers.clearBug({ simulationId, entity: payment });
  await owner.reducers.clearBug({ simulationId, entity: payment });
  const remaining = () => [...owner.db.worldStates.iter()].filter(row => row.key.startsWith('lattice.impact:'));
  assert.deepEqual(remaining().map(row => row.key), [`lattice.impact:${reporting}`]);
  await owner.reducers.clearBug({ simulationId, entity: reporting });
  assert.equal(remaining().length, 0);
  await sleep(1000);
  assert.equal([...owner.db.worldStates.iter()].some(row => row.key === 'report-response'), false);
  await owner.reducers.setBug({ simulationId, entity: payment });
  assert.equal(remaining().length, 3);
  await owner.reducers.stopSimulation({ id: simulationId });
  await assert.rejects(owner.reducers.requestEvent({ simulationId, entity: checkout, event: 'prepare', delayMs: 1 }), /stopped/i);
});
