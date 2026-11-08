import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DbConnection, tables } from '../../db/client/index.js';
import type { AgentId, SourceKind } from '../../shared/types/index.js';
import { loadProjectEnv } from './env.js';
import { createExtractor } from './provider.js';
import { runAgent } from './runner.js';
import { SpacetimeAgentDatabase } from './spacetimedb-database.js';

const root = new URL('../../', import.meta.url);
loadProjectEnv(fileURLToPath(root));
const role = process.argv[2]?.toUpperCase();
if (role !== 'A' && role !== 'B' && role !== 'C' && role !== 'D') {
  throw new Error('Usage: node --import tsx agents/src/cli.ts A (or B, C, D)');
}
const id: AgentId = role;
function readLocal(file: string) {
  try {
    return readFileSync(new URL(`.data/${file}`, root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
const config: { uri?: string; database?: string } = JSON.parse(readLocal('lattice.json') ?? '{}');
const uri = process.env.LATTICE_DB_URL ?? config.uri;
const database = process.env.LATTICE_DATABASE ?? config.database;
const token = process.env[`LATTICE_AGENT_${id}_TOKEN`] ?? readLocal(`agent-${id}.token`)?.trim();
if (!uri || !database || !token) throw new Error(`Configure the database and a registered token for Agent ${id}`);
const extractionMs = Number(process.env.LATTICE_AGENT_DELAY_MS ?? 0);
if (!Number.isFinite(extractionMs) || extractionMs < 0) throw new Error('Invalid LATTICE_AGENT_DELAY_MS');
const extractor = createExtractor();
let run: AbortController | undefined;
let attemptedEpoch: number | undefined;
let closing = false;
let applied = false;

const connection = DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(database)
  .withToken(token)
  .onConnect(conn => {
    const reconcile = () => {
      if (closing || !applied) return;
      const [source] = conn.db.mySources.iter();
      if (!source) {
        run?.abort();
        return;
      }
      if (source.epoch === attemptedEpoch) return;
      run?.abort();
      attemptedEpoch = source.epoch;
      const controller = new AbortController();
      run = controller;
      const scoped = new SpacetimeAgentDatabase(id, {
        async readAssignedSources() { return [{ ...source, kind: source.kind as SourceKind }]; },
        submitEvidence: (sourceId, payloadJson, expectedEpoch) =>
          conn.reducers.submitEvidence({ sourceId, payloadJson, expectedEpoch }),
        updateStatus: (status, message, expectedEpoch) =>
          conn.reducers.updateAgentStatus({ status, message, expectedEpoch }),
      });
      void runAgent({ id, database: scoped, extractor, extractionMs, signal: controller.signal })
        .catch(error => console.error(`Agent ${id}: ${error instanceof Error ? error.message : String(error)}`));
    };
    const changed = () => queueMicrotask(reconcile);
    conn.db.mySources.onInsert(changed);
    conn.db.mySources.onUpdate(changed);
    conn.db.mySources.onDelete(changed);
    conn.subscriptionBuilder()
      .onApplied(() => {
        applied = true;
        console.log(`Agent ${id} subscribed to assigned work`);
        reconcile();
      })
      .onError(() => fail('Assigned work subscription failed'))
      .subscribe(tables.mySources);
  })
  .onConnectError((_ctx, error) => fail(error.message))
  .onDisconnect(() => { if (!closing) fail('Database connection lost'); })
  .build();

function stop() {
  if (closing) return;
  closing = true;
  run?.abort();
  connection.disconnect();
}
function fail(message: string) {
  console.error(`Agent ${id}: ${message}`);
  process.exitCode = 1;
  stop();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
