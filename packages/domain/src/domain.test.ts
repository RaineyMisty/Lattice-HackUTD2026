import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialWorld, injectIncident, submitEvidence, DEMO_SOURCES, compareVersions, deriveWorld } from './index';
import type { AgentId, EvidencePayload, WorldSnapshot } from '../../contracts/src/index';

const timestamp = '2026-11-07T12:00:00.000Z';
const sourceKinds = { A: 'advisory', B: 'dependencies', C: 'deployments', D: 'ownership' };
function submit(world: WorldSnapshot, id: AgentId, payload?: EvidencePayload) {
  const source = DEMO_SOURCES.find(source => source.kind === sourceKinds[id])!;
  return submitEvidence(world, id, source.id, payload ?? JSON.parse(source.body), timestamp);
}
const injected = () => injectIncident(createInitialWorld(), timestamp);
function permutations<T>(items: T[]): T[][] { return items.length ? items.flatMap((value, i) => permutations(items.filter((_, j) => i !== j)).map(rest => [value, ...rest])) : [[]]; }

test('initial world has no conclusions or tasks; advisory arrives on injection', () => {
  const initial = createInitialWorld();
  assert.ok(initial.assets.every(asset => asset.status === 'unknown'));
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.sources.some(source => source.kind === 'advisory'), false);
  const world = injectIncident(initial, timestamp);
  assert.equal(world.sources.length, 4);
  assert.equal(initial.incident, null);
  assert.deepEqual(injectIncident(world, timestamp), world);
});

test('all 24 agent completion orders converge to identical classifications and tasks', () => {
  let expected: unknown;
  for (const order of permutations<AgentId>(['A', 'B', 'C', 'D'])) {
    const world = order.reduce((state, id) => submit(state, id), injected());
    const result = { assets: world.assets, tasks: world.tasks, notifications: world.notifications };
    expected ??= result;
    assert.deepEqual(result, expected, order.join(''));
    assert.deepEqual(world.assets.map(asset => asset.status), ['direct', 'downstream', 'downstream', 'unaffected']);
    assert.deepEqual(world.tasks.map(task => [task.assetId, task.priority]), [['auth', 'P0'], ['checkout', 'P1'], ['merchant', 'P1']]);
    assert.equal(world.notifications.length, 3);
    assert.ok(world.tasks.every(task => task.evidenceIds.includes('evidence-D')));
  }
});

test('late deployment evidence upgrades possible risk to actionable assignments', () => {
  let world = ['A', 'B', 'D'].reduce((state, id) => submit(state, id as AgentId), injected());
  assert.ok(world.assets.every(asset => asset.status === 'possible'));
  assert.equal(world.tasks.length, 0);
  world = submit(world, 'C');
  assert.equal(world.tasks.length, 3);
  assert.equal(world.assets.find(asset => asset.id === 'reporting')?.status, 'unaffected');
  assert.equal(world.tasks.some(task => task.assetId === 'reporting'), false);
  assert.deepEqual(world.assets.find(asset => asset.id === 'checkout')?.impactPath, ['checkout', 'auth']);
});

test('missing ownership never invents a department, and duplicate writes are idempotent', () => {
  let world = ['A', 'B', 'C'].reduce((state, id) => submit(state, id as AgentId), injected());
  assert.equal(world.tasks.length, 0);
  world = submit(world, 'D');
  assert.deepEqual(submit(world, 'D'), world);
  assert.deepEqual(deriveWorld(world, timestamp), world);
});

test('numeric version boundaries do not use lexical comparison', () => {
  assert.equal(compareVersions('1.8.10', '1.8.2'), 1);
  for (const version of ['1.8.0', '1.8.2']) {
    const world = submit(submit(injected(), 'A'), 'C', { kind: 'deployments', deployments: [{ assetId: 'auth', component: 'TokenGate', version, environment: 'production' }] });
    assert.equal(world.assets[0].status, 'direct');
  }
  for (const version of ['1.7.99', '1.8.3', '1.8.10', '2.0.0']) {
    const world = submit(submit(injected(), 'A'), 'C', { kind: 'deployments', deployments: [{ assetId: 'auth', component: 'TokenGate', version, environment: 'production' }] });
    assert.equal(world.assets[0].status, 'unaffected');
  }
  assert.throws(() => compareVersions('1.8.1-beta', '1.8.2'));
});

test('transitive dependencies and cycles terminate with full provenance', () => {
  const dependencies: EvidencePayload = { kind: 'dependencies', dependencies: [
    { from: 'checkout', to: 'auth', kind: 'service' }, { from: 'merchant', to: 'checkout', kind: 'service' },
    { from: 'auth', to: 'merchant', kind: 'service' },
  ] };
  let world = submit(submit(injected(), 'A'), 'C');
  world = submit(world, 'B', dependencies);
  assert.deepEqual(world.assets.find(asset => asset.id === 'merchant')?.impactPath, ['merchant', 'checkout', 'auth']);
  assert.deepEqual(world.assets.find(asset => asset.id === 'merchant')?.evidenceIds, ['evidence-A', 'evidence-C', 'evidence-B']);
  assert.equal(world.assets[0].status, 'direct');
});

test('patched deployment removes previously generated tasks and notifications', () => {
  let world = (['A', 'B', 'C', 'D'] as AgentId[]).reduce((state, id) => submit(state, id), injected());
  const payload = JSON.parse(DEMO_SOURCES.find(source => source.kind === 'deployments')!.body);
  payload.deployments[0].version = '1.8.3';
  world = submit(world, 'C', payload);
  assert.equal(world.tasks.length, 0);
  assert.equal(world.notifications.length, 0);
  assert.equal(world.assets[0].status, 'unaffected');
});

test('rejects cross-agent writes, forged conclusions, invalid versions and nonexistent sources', () => {
  const world = injected();
  const a = JSON.parse(DEMO_SOURCES[0].body);
  assert.throws(() => submitEvidence(world, 'B', 'source-advisory', a, timestamp));
  assert.throws(() => submitEvidence(world, 'A', 'source-deployments', a, timestamp));
  assert.throws(() => submitEvidence(world, 'A', 'made-up', a, timestamp));
  assert.throws(() => submit(world, 'A', { ...a, tasks: [] }));
  assert.throws(() => submit(world, 'A', { ...a, vulnerability: { ...a.vulnerability, minVersion: '1.8.x' } }));
  assert.throws(() => submit(createInitialWorld(), 'A'));
});

test('development deployments never count as production exposure', () => {
  const world = submit(submit(injected(), 'A'), 'C', { kind: 'deployments', deployments: [{ assetId: 'auth', component: 'TokenGate', version: '1.8.1', environment: 'development' }] });
  assert.equal(world.assets[0].status, 'unknown');
  assert.equal(world.tasks.length, 0);
});
