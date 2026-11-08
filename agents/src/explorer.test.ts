import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentManager } from './index.ts';
import type { CodingHarness, HarnessSessionOptions, HarnessTurn } from './index.ts';

const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
const files: Record<string, string> = {
  'a.ts': "import './b.ts';",
  'b.ts': 'export const b = 2;',
  'c.ts': 'export const c = 3;',
  'd.ts': 'export const d = 4;',
};

async function withRepository(check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lattice-agent-test-'));
  try {
    await Promise.all(names.map(name => writeFile(join(root, name), files[name] + '\n')));
    await check(root);
  } finally {
    await Promise.all(names.map(name => unlink(join(root, name)).catch(() => undefined)));
    await rmdir(root);
  }
}

function currentFile(turn: HarnessTurn): string {
  const line = turn.prompt.split('\n').find(item => item.startsWith('Current task (data): '));
  assert.ok(line);
  return (JSON.parse(line.slice('Current task (data): '.length)) as { path: string }).path;
}
const node = (path: string) => ({ kind: 'file', name: path, path });
const cite = (path: string, quote = files[path]) => ({ path, startLine: 1, endLine: 1, quote });

test('four independent sessions publish checked discoveries, merge duplicates, and consume follow-up work', async () => {
  await withRepository(async repositoryPath => {
    const sessions: HarnessSessionOptions[] = [];
    let openAll!: () => void;
    const allOpen = new Promise<void>(resolve => { openAll = resolve; });
    const harness: CodingHarness = {
      openSession(options) {
        sessions.push(options);
        if (sessions.length === 4) openAll();
        return {
          async run(turn) {
            await allOpen;
            const path = currentFile(turn);
            await turn.onActivity('Read source');
            return JSON.stringify({
              nodes: [{ node: node(path), evidence: cite(path) },
                { node: node('b.ts'), evidence: cite('b.ts', 'fabricated quote') },
                { node: node('../private.ts'), evidence: cite('a.ts') }],
              edges: path === 'a.ts' ? [{ from: node('a.ts'), to: node('b.ts'), relationship: 'imports', evidence: cite(path) }] : [],
              tasks: [{ path: 'a.ts', question: 'Trace the import in the entry file.' }],
            });
          },
        };
      },
    };
    const manager = new AgentManager({ harness });
    const run = await manager.start({ repositoryPath, seed: 29, maxTurnsPerAgent: 3 });
    const done = await run.done;
    const graph = await manager.getContext(run.id);
    assert.equal(done.phase, 'completed');
    assert.equal(new Set(sessions.map(item => item.sessionId)).size, 4);
    assert.equal(new Set(sessions.map(item => item.seed)).size, 4);
    assert.equal(new Set(sessions.map(item => item.startPath)).size, 4);
    assert.equal(done.agents.reduce((sum, item) => sum + item.turns, 0), 5);
    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.evidence.length, 4);
    assert.ok(graph.evidence.every(item => item.verification === 'source-matched'));
    assert.ok(graph.tasks.every(item => item.state === 'completed'));
    assert.ok(graph.activity.some(item => item.kind === 'verification' && item.message.endsWith('2 rejected')));
  });
});

test('stop cancels a live turn and releases its task without publishing discoveries', async () => {
  await withRepository(async repositoryPath => {
    let onStarted!: () => void;
    const started = new Promise<void>(resolve => { onStarted = resolve; });
    const harness: CodingHarness = {
      openSession: () => ({
        async run(turn) {
          onStarted();
          await delay(5000, undefined, { signal: turn.signal });
          return '{"nodes":[],"edges":[],"tasks":[]}';
        },
      }),
    };
    const manager = new AgentManager({ harness });
    const run = await manager.start({ repositoryPath, agentCount: 1, seed: 0 });
    await started;
    assert.equal(run.getStatus().agents[0].phase, 'running');
    const result = await run.stop();
    assert.equal(result.phase, 'stopped');
    assert.equal(result.agents[0].phase, 'stopped');
    assert.equal((await manager.getContext(run.id)).tasks[0].state, 'pending');
    assert.equal((await manager.getContext(run.id)).nodes.length, 0);
  });
});

test('invalid harness output fails its claim and reports a terminal status', async () => {
  await withRepository(async repositoryPath => {
    const manager = new AgentManager({ harness: { openSession: () => ({ run: async () => 'invalid JSON' }) } });
    const run = await manager.start({ repositoryPath, agentCount: 1, seed: 5 });
    assert.equal((await run.done).phase, 'failed');
    const context = await manager.getContext(run.id);
    assert.equal(context.tasks[0].state, 'failed');
    assert.ok(context.agents[0].error);
    assert.deepEqual(context.evidence, []);
  });
});
