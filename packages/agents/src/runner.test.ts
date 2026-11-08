import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDatabase, AgentId, EvidencePayload } from '../../contracts/src/index.js';
import { FixtureExtractor, createExtractor } from './provider.js';
import { runAgent } from './runner.js';
import { SpacetimeAgentDatabase } from './spacetimedb-database.js';

test('agent only reads its own source and submits extracted facts', async () => {
  const calls: string[] = [];
  const fact: EvidencePayload = { kind: 'deployments', deployments: [{ assetId: 'auth', component: 'TokenGate', version: '1.8.1', environment: 'production' }] };
  const database: AgentDatabase = {
    async readSources(id) { calls.push(`read:${id}`); return [{ id: 'source-deployments', kind: 'deployments', title: 'Deployment record', body: JSON.stringify(fact) }]; },
    async updateStatus(id, status) { calls.push(`status:${id}:${status}`); },
    async submitEvidence(id, sourceId, payload) { calls.push(`submit:${id}:${sourceId}`); assert.deepEqual(payload, fact); },
  };
  await runAgent({ id: 'C', database, extractor: new FixtureExtractor() });
  assert.deepEqual(calls, ['read:C', 'status:C:reading', 'status:C:extracting', 'submit:C:source-deployments']);
});

test('live database adapter cannot impersonate another agent', async () => {
  const database = new SpacetimeAgentDatabase('A', {
    async readAssignedSources() { return []; }, async submitEvidence() {}, async updateStatus() {},
  });
  await assert.rejects(database.readSources('B' as AgentId), /role mismatch/);
});

test('model mode never falls back to fixtures when credentials are missing', () => {
  assert.throws(() => createExtractor({ LATTICE_AGENT_PROVIDER: 'model' }), /requires/);
});

test('live adapter pins its source epoch and cannot adopt a later run', async () => {
  let epoch = 7;
  const writes: number[] = [];
  const database = new SpacetimeAgentDatabase('A', {
    async readAssignedSources() { return [{ id: 'source-advisory', kind: 'advisory', title: 'Advisory', body: '{}', epoch }]; },
    async submitEvidence(_sourceId, _payloadJson, expectedEpoch) { writes.push(expectedEpoch); },
    async updateStatus(_status, _message, expectedEpoch) { writes.push(expectedEpoch); },
  });
  await assert.rejects(database.updateStatus('A', 'reading', 'Reading'), /Read the assigned source/);
  await database.readSources('A');
  await database.updateStatus('A', 'extracting', 'Extracting');
  epoch = 8;
  await assert.rejects(database.readSources('A'), /create a new database adapter/);
  await database.submitEvidence('A', 'source-advisory', { kind: 'vulnerability', vulnerability: { component: 'TokenGate', minVersion: '1.8.0', maxVersion: '1.8.2', fixedVersion: '1.8.3', severity: 'critical' } });
  assert.deepEqual(writes, [7, 7]);
});
