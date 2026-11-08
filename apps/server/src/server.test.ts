import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, SourceRecord, WorldSnapshot } from '../../../packages/contracts/src/index.js';
import { createDemoServer, type DemoServer } from './server.js';

const env = { LATTICE_AGENT_A_TOKEN: 'test-A', LATTICE_AGENT_B_TOKEN: 'test-B', LATTICE_AGENT_C_TOKEN: 'test-C', LATTICE_AGENT_D_TOKEN: 'test-D', LATTICE_AGENT_PROVIDER: 'fixture' };
const post = (demo: DemoServer, path: string, body: unknown = {}, headers = {}) => fetch(`${demo.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bearer = (id: AgentId) => ({ Authorization: `Bearer test-${id}` });
async function source(demo: DemoServer, id: AgentId) {
  const response = await fetch(`${demo.url}/api/agents/${id}/sources`, { headers: bearer(id) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ generation: number; sources: SourceRecord[] }>;
}
async function submit(demo: DemoServer, id: AgentId) {
  const data = await source(demo, id);
  assert.equal(data.sources.length, 1);
  return post(demo, `/api/agents/${id}/evidence`, { sourceId: data.sources[0].id, payload: JSON.parse(data.sources[0].body) },
    { ...bearer(id), 'X-Lattice-Generation': String(data.generation) });
}

test('scoped agent API rejects impersonation, administration, and final-risk writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lattice-auth-'));
  const demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
  try {
    assert.equal((await post(demo, '/api/incidents/inject')).status, 200);
    assert.equal((await fetch(`${demo.url}/api/agents/B/sources`, { headers: bearer('A') })).status, 403);
    assert.equal((await post(demo, '/api/demo/reset', {}, bearer('A'))).status, 403);
    assert.equal((await fetch(`${demo.url}/api/world`, { headers: bearer('A') })).status, 403);
    const data = await source(demo, 'A');
    const headers = { ...bearer('A'), 'X-Lattice-Generation': String(data.generation) };
    const response = await post(demo, '/api/agents/A/evidence', { sourceId: data.sources[0].id, payload: { kind: 'risk', assetId: 'auth', status: 'direct', priority: 'P0' } }, headers);
    assert.equal(response.status, 400);
    assert.equal(demo.store.snapshot().evidence.length, 0);
    assert.equal((await post(demo, '/api/incidents/inject', {}, { Origin: 'https://untrusted.example' })).status, 403);
  } finally { await demo.close(); await rm(directory, { recursive: true, force: true }); }
});

test('database creates three tasks, deduplicates evidence, and survives server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lattice-persist-'));
  let demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
  try {
    await post(demo, '/api/incidents/inject');
    for (const id of ['D', 'B', 'A'] as AgentId[]) assert.equal((await submit(demo, id)).status, 200);
    assert.equal(demo.store.snapshot().tasks.length, 0);
    assert.equal((await submit(demo, 'C')).status, 200);
    const completed = demo.store.snapshot();
    assert.equal(completed.tasks.length, 3);
    assert.equal(completed.notifications.length, 3);
    assert.equal(completed.assets.find(asset => asset.id === 'reporting')?.status, 'unaffected');
    const rerun = await source(demo, 'C');
    await post(demo, '/api/agents/C/status', { status: 'extracting', message: 'Rechecking same source' }, { ...bearer('C'), 'X-Lattice-Generation': String(rerun.generation) });
    assert.equal((await submit(demo, 'C')).status, 200);
    assert.equal(demo.store.snapshot().agents.find(agent => agent.id === 'C')?.status, 'submitted');
    assert.equal(demo.store.snapshot().tasks.length, 3);
    assert.equal(demo.store.snapshot().notifications.length, 3);
    await post(demo, '/api/agents/stop');
    const stopped = demo.store.snapshot();
    await demo.close();
    demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
    const restored = await (await fetch(`${demo.url}/api/world`)).json() as WorldSnapshot;
    assert.deepEqual(restored.tasks, stopped.tasks);
    assert.deepEqual(restored.notifications, stopped.notifications);
    assert.deepEqual(restored.assets, stopped.assets);
    assert.equal(restored.agentsStopped, true);
  } finally { await demo.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stopping agents cancels delayed submissions and reset invalidates stale writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lattice-stop-'));
  const demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
  try {
    await post(demo, '/api/incidents/inject');
    const before = await source(demo, 'A');
    assert.equal((await post(demo, '/api/demo/start', { pace: 'fast' })).status, 200);
    assert.equal((await post(demo, '/api/agents/stop')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(demo.store.snapshot().evidence.length, 0);
    assert.ok(demo.store.snapshot().agents.every(agent => agent.status === 'stopped'));
    await post(demo, '/api/demo/reset');
    await post(demo, '/api/incidents/inject');
    const stale = await post(demo, '/api/agents/A/evidence', { sourceId: before.sources[0].id, payload: JSON.parse(before.sources[0].body) }, { ...bearer('A'), 'X-Lattice-Generation': String(before.generation) });
    assert.equal(stale.status, 409);
    assert.equal(demo.store.snapshot().evidence.length, 0);
  } finally { await demo.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SSE streams an initial persisted snapshot and a committed incident update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lattice-sse-'));
  const demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
  const controller = new AbortController();
  try {
    const response = await fetch(`${demo.url}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: world/);
    assert.match(initial, /"incident":null/);
    await post(demo, '/api/incidents/inject');
    const changed = new TextDecoder().decode((await reader.read()).value);
    assert.match(changed, /DEMO-SEC-001/);
    await reader.cancel();
  } finally { controller.abort(); await demo.close(); await rm(directory, { recursive: true, force: true }); }
});

test('four parallel HTTP agents complete the full extraction-to-inbox flow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lattice-flow-'));
  const demo = await createDemoServer({ dataDirectory: directory, port: 0, env });
  try {
    await post(demo, '/api/incidents/inject');
    assert.equal((await post(demo, '/api/demo/start', { pace: 'fast' })).status, 200);
    const deadline = Date.now() + 10_000;
    while (demo.store.snapshot().evidence.length < 4 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const world = demo.store.snapshot();
    assert.equal(world.evidence.length, 4);
    assert.ok(world.agents.every(agent => agent.status === 'submitted'));
    assert.equal(world.tasks.length, 3);
    assert.equal(world.notifications.length, 3);
    assert.equal(world.assets.find(asset => asset.id === 'auth')?.status, 'direct');
    assert.equal(world.assets.find(asset => asset.id === 'checkout')?.status, 'downstream');
    assert.equal(world.assets.find(asset => asset.id === 'merchant')?.status, 'downstream');
    assert.equal(world.assets.find(asset => asset.id === 'reporting')?.status, 'unaffected');
  } finally { await demo.close(); await rm(directory, { recursive: true, force: true }); }
});
