import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { entityKey, worldConnection, worldQueries, type DbConnection } from '../../spacetime_db/client/index.ts';
import { AgentManager, SpacetimeExplorationDatabase, type CodingHarness } from './index.ts';

const token = process.env.LATTICE_STDB_TEST_TOKEN;
const uri = process.env.LATTICE_STDB_TEST_URI ?? 'http://127.0.0.1:3381';
const database = 'lattice-agent-loop-test';
const sources: Record<string, string> = {
  'checkout.ts': 'export function checkout() { return charge() ? "OK" : "FAILED"; }',
  'payment.ts': 'export function charge() { return false; }',
  'report.ts': 'export function report() { return "ready"; }',
  'ship.ts': 'export function ship() { return "shipped"; }',
};
const empty = { entities: [], relations: [], behaviors: [], tasks: [] };
const source = (path: string) => ({ path, startLine: 1, endLine: 1, excerpt: sources[path] });

async function waitUntil<T>(read: () => T | undefined, label: string) {
  for (let i = 0; i < 300; i++) {
    const result = read();
    if (result !== undefined) return result;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('four live Explorers share verified Git discoveries and the database executes the resulting behavior', { skip: !token, timeout: 80_000 }, async t => {
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(uri).hostname));
  const base = resolve(tmpdir());
  const root = await mkdtemp(join(base, 'lattice-world-loop-'));
  t.after(async () => {
    if (dirname(root) === base && basename(root).startsWith('lattice-world-loop-')) {
      await rm(root, { recursive: true, force: true });
    }
  });
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  await Promise.all(Object.entries(sources).map(([path, text]) => writeFile(join(root, path), text + '\n')));
  git('add', '.');
  git('-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial source');
  const commit = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'untracked.ts'), 'export const fake = true;\n');
  const worldId = `world-${randomUUID()}`;
  const checkout = { kind: 'function', path: 'checkout.ts', symbol: 'checkout' } as const;
  const payment = { kind: 'function', path: 'payment.ts', symbol: 'charge' } as const;
  const observed: string[] = [];
  const harness: CodingHarness = {
    openSession() {
      return { async run(turn) {
        assert.match(turn.prompt, /Assigned source from the selected Git commit/);
        const row = turn.prompt.split('\n').find(line => line.startsWith('Current task (data): '))!;
        const task = JSON.parse(row.slice('Current task (data): '.length)) as { path: string; question: string };
        observed.push(task.question);
        assert.ok(turn.prompt.includes(`1: ${sources[task.path]}`));
        if (task.question === 'Trace payment retries') {
          assert.match(turn.prompt, /payment\.return\.failed/);
        }
        if (task.path !== 'checkout.ts') return JSON.stringify({
          ...empty, entities: [{ entity: { kind: 'file', path: task.path, symbol: '' }, source: source(task.path) }],
        });
        return JSON.stringify({
          entities: [
            { entity: checkout, source: source('checkout.ts') }, { entity: payment, source: source('payment.ts') },
            { entity: { ...checkout, symbol: 'fabricated' }, source: { ...source('checkout.ts'), excerpt: 'forged line' } },
          ],
          relations: [{ from: checkout, to: payment, kind: 'calls', source: source('checkout.ts') }],
          behaviors: [{
            entity: checkout, name: 'payment failure', source: source('checkout.ts'),
            rule: { event: 'payment.return.failed', when: [], set: [{ key: 'result', value: '"FAILED"' }], emit: [], retry: null },
          }],
          tasks: [{ path: 'payment.ts', question: 'Trace payment retries' }, { path: 'untracked.ts', question: 'Reject untracked files' }],
        });
      } };
    },
  };
  const adapter = new SpacetimeExplorationDatabase({ uri, database, worldId, token, createWorld: true });
  const manager = new AgentManager({ database: adapter, harness });
  const first = await manager.start({ repositoryPath: root, agentCount: 4, seed: 2, maxTurnsPerAgent: 1 });
  const finished = await first.done;
  assert.equal(finished.phase, 'completed', JSON.stringify(finished.agents));
  assert.ok(finished.agents.every(agent => agent.turns === 1));

  const owner = await new Promise<DbConnection>((resolve, reject) => {
    worldConnection({ uri, database, token }).onConnect(resolve).onConnectError((_ctx, error) => reject(error)).build();
  });
  t.after(() => owner.disconnect());
  await new Promise<void>((resolve, reject) => owner.subscriptionBuilder().onApplied(() => resolve())
    .onError(ctx => reject(ctx.event)).subscribe(worldQueries(worldId)));
  const facts = [...owner.db.worldEntities.iter()];
  const tasks = [...owner.db.worldFrontier.iter()];
  assert.equal(facts.length, 5);
  assert.equal(owner.db.worldRelations.count(), 1n);
  assert.equal(owner.db.worldBehaviors.count(), 1n);
  assert.equal([...owner.db.myWorlds.iter()][0].commit, commit);
  assert.ok([...owner.db.worldEvidence.iter()].every(row => row.commit === commit));
  assert.equal(new Set(tasks.filter(row => row.status === 'done').map(row => row.claimant?.toHexString())).size, 4);
  assert.deepEqual(tasks.filter(row => row.status === 'queued').map(row => row.question), ['Trace payment retries']);

  const follow = await manager.start({ repositoryPath: root, agentCount: 1, maxTurnsPerAgent: 1 });
  assert.equal((await follow.done).phase, 'completed');
  assert.ok(observed.includes('Trace payment retries'));

  const continuous = await manager.start({ repositoryPath: root, agentCount: 1 });
  t.after(() => continuous.stop());
  await waitUntil(() => continuous.getStatus().agents[0].phase === 'waiting' ? true : undefined, 'idle worker');
  await owner.reducers.submitDiscovery({
    ...empty, worldId, tasks: [{ path: 'report.ts', question: 'Check subscription wakeup' }], completes: undefined,
  });
  await waitUntil(() => continuous.getStatus().agents[0].turns === 1 ? true : undefined, 'subscription wakeup');
  assert.equal((await continuous.stop()).phase, 'stopped');

  const simulationId = `sim-${randomUUID()}`;
  await owner.reducers.createSimulation({ worldId, id: simulationId, label: 'Behavior after workers exit' });
  await owner.reducers.requestEvent({
    simulationId, entity: entityKey(checkout.kind, checkout.path, checkout.symbol), event: 'payment.return.failed', delayMs: 0,
  });
  await waitUntil(() => [...owner.db.worldStates.iter()].find(row => row.simulationId === simulationId && row.value === '"FAILED"'), 'database behavior');

  await writeFile(join(root, 'report.ts'), 'export function report() { return "changed"; }\n');
  await assert.rejects(manager.start({ repositoryPath: root, agentCount: 1, maxTurnsPerAgent: 1 }), /tracked working tree/);
});
