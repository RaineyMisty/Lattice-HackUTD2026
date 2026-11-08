import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DbConnection, tables } from '../client';
import type { AgentId, WorldSnapshot } from '../../shared/types';

const config = JSON.parse(readFileSync('.data/lattice.json', 'utf8')) as {
  uri: string; database: string;
};
const operatorLink = new URL(readFileSync('.data/operator-url.txt', 'utf8').trim());
const operatorToken = new URLSearchParams(operatorLink.hash.slice(1)).get('operator');
assert.ok(operatorToken, 'Run local setup to provision the operator and Agents');
const agentToken = (role: AgentId) => readFileSync(`.data/agent-${role}.token`, 'utf8').trim();
const roles = ['A', 'B', 'C', 'D'] as const;
const workerArgs = ['--import', 'tsx', 'agents/src/cli.ts'];

function connect(token: string, access: 'operator' | 'agent') {
  return new Promise<DbConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.disconnect();
      reject(new Error(`Timed out subscribing as ${access}`));
    }, 10_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
      conn.disconnect();
    };
    const conn = DbConnection.builder().withUri(config.uri).withDatabaseName(config.database).withToken(token)
      .onConnect(client => client.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timeout); resolve(client); })
        .onError(() => fail(new Error('Subscription failed')))
        .subscribe(access === 'operator' ? [tables.dashboardWorld, tables.departmentNotification, tables.incidentTask] : [tables.mySources, tables.dashboardWorld]))
      .onConnectError((_ctx, error) => fail(error))
      .build();
  });
}

function world(conn: DbConnection): WorldSnapshot {
  const [row] = conn.db.dashboardWorld.iter();
  assert.ok(row, 'Operator must see the subscribed dashboard row');
  return JSON.parse(row.snapshotJson);
}

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(30);
  }
  assert.fail(message);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('live role isolation, reducer rejection and epoch fencing', async () => {
  const operator = await connect(operatorToken, 'operator');
  const agent = await connect(agentToken('A'), 'agent');
  try {
    await operator.reducers.resetDemo({});
    await until(() => world(operator).incident === null, 'Reset snapshot did not arrive');
    assert.equal([...agent.db.mySources.iter()].length, 0);
    await operator.reducers.injectIncident({});
    await until(() => [...agent.db.mySources.iter()].length === 1, 'Assigned source did not arrive');
    const [source] = agent.db.mySources.iter();
    assert.equal(source.kind, 'advisory');
    assert.equal([...agent.db.dashboardWorld.iter()].length, 0);
    await assert.rejects(agent.reducers.resetDemo({}), /operator/i);
    await assert.rejects(agent.reducers.submitEvidence({
      sourceId: 'source-deployments', payloadJson: source.body, expectedEpoch: source.epoch,
    }));
    await assert.rejects(agent.reducers.submitEvidence({
      sourceId: source.id, payloadJson: JSON.stringify({ ...JSON.parse(source.body), finalRisk: 'direct' }),
      expectedEpoch: source.epoch,
    }));
    await operator.reducers.stopAgents({});
    await until(() => [...agent.db.mySources.iter()].length === 0, 'Stopped work was not revoked');
    await operator.reducers.resetDemo({});
    await operator.reducers.injectIncident({});
    await assert.rejects(agent.reducers.submitEvidence({
      sourceId: source.id, payloadJson: source.body, expectedEpoch: source.epoch,
    }), /expired/i);
    assert.equal(world(operator).evidence.length, 0);
  } finally {
    agent.disconnect();
    operator.disconnect();
  }
});

test('four independent workers produce live graph and inbox updates that survive worker exit', async () => {
  const operator = await connect(operatorToken, 'operator');
  const children: ChildProcess[] = [];
  const ready = new Set<string>();
  const progress = new Set<string>();
  const failures: string[] = [];
  try {
    await operator.reducers.resetDemo({});
    await until(() => world(operator).incident === null, 'Initial reset did not reach the subscription');
    operator.db.dashboardWorld.onUpdate((_ctx, _before, row) => {
      const state = JSON.parse(row.snapshotJson) as WorldSnapshot;
      for (const agent of state.agents) if (agent.status === 'extracting') progress.add(agent.id);
    });
    for (const [index, role] of roles.entries()) {
      const child = spawn(process.execPath, [...workerArgs, role], {
        env: {
          ...process.env, LATTICE_DB_URL: config.uri, LATTICE_DATABASE: config.database,
          [`LATTICE_AGENT_${role}_TOKEN`]: agentToken(role),
          LATTICE_AGENT_PROVIDER: 'fixture', LATTICE_AGENT_DELAY_MS: String(250 + index * 250),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let log = '';
      child.stdout!.on('data', chunk => {
        log += String(chunk);
        if (log.includes(`Agent ${role} subscribed`)) ready.add(role);
      });
      child.stderr!.on('data', chunk => failures.push(String(chunk)));
      child.on('error', error => failures.push(error.message));
    }
    assert.equal(new Set(children.map(child => child.pid)).size, 4);
    await until(() => ready.size === 4, `Workers did not subscribe. ${failures.join(' ')}`);
    await operator.reducers.injectIncident({});
    await until(() => world(operator).evidence.length === 4, `Investigation did not finish. ${failures.join(' ')}`);
    const completed = world(operator);
    assert.deepEqual([...progress].sort(), [...roles]);
    assert.equal(new Set(completed.evidence.map(row => row.payload.kind)).size, 4);
    assert.ok(completed.agents.every(agent => agent.status === 'submitted'));
    assert.deepEqual(Object.fromEntries(completed.assets.map(asset => [asset.id, asset.status])), {
      auth: 'direct', checkout: 'downstream', merchant: 'downstream', reporting: 'unaffected',
    });
    assert.equal(completed.dependencies.length, 4);
    assert.equal(completed.tasks.length, 3);
    assert.equal(completed.notifications.length, 3);
    assert.equal([...operator.db.incidentTask.iter()].length, 3);
    assert.equal([...operator.db.departmentNotification.iter()].length, 3);
    await Promise.all(children.map(stop));
    await operator.reducers.stopAgents({});
    const fresh = await connect(operatorToken, 'operator');
    try {
      const retained = world(fresh);
      assert.deepEqual(retained.assets, completed.assets);
      assert.deepEqual(retained.tasks, completed.tasks);
      assert.deepEqual(retained.notifications, completed.notifications);
      assert.equal(retained.agentsStopped, true);
    } finally {
      fresh.disconnect();
    }
  } finally {
    await Promise.all(children.map(stop));
    operator.disconnect();
  }
});
