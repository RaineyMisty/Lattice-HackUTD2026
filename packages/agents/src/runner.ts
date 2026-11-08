import type { AgentDatabase, AgentId, SourceRecord } from '../../contracts/src/index.js';
import { AGENT_SOURCE } from '../../contracts/src/index.js';
import type { EvidenceExtractor } from './provider.js';

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Agent stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A runner has exactly one scoped database client and no reference to another agent. */
export async function runAgent(options: {
  id: AgentId;
  database: AgentDatabase;
  extractor: EvidenceExtractor;
  signal?: AbortSignal;
  readingMs?: number;
  extractionMs?: number;
}): Promise<void> {
  const { id, database, extractor, signal, readingMs = 0, extractionMs = 0 } = options;
  try {
    const sources = await database.readSources(id);
    signal?.throwIfAborted();
    await database.updateStatus(id, 'reading', `Reading ${AGENT_SOURCE[id]} source from database`);
    await delay(readingMs, signal);
    const source: SourceRecord | undefined = sources.find(row => row.kind === AGENT_SOURCE[id]);
    if (!source) throw new Error(`No ${AGENT_SOURCE[id]} source is available`);
    await database.updateStatus(id, 'extracting', 'Extracting evidence · no risk inference');
    const payload = await extractor.extract(id, source, signal);
    await delay(extractionMs, signal);
    signal?.throwIfAborted();
    await database.submitEvidence(id, source.id, payload);
  } catch (error) {
    if (!signal?.aborted) {
      await database.updateStatus(id, 'error', error instanceof Error ? error.message : 'Extraction failed').catch(() => undefined);
      throw error;
    }
  }
}
