import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MemoryExplorationDatabase } from './database/client.ts';
import type { AgentStatus, ExplorationDatabase, ExplorationTask, RunIdentity } from './database/interface.ts';
import { runExplorer } from './explorer/explorer.ts';
import { CodexHarness } from './explorer/harness.ts';
import type { CodingHarness } from './explorer/harness.ts';
import { indexSources, repositoryRoot, stableId } from './explorer/repository.ts';

export interface StartExploration {
  repositoryPath: string;
  agentCount?: number;
  seed?: number;
  maxTurnsPerAgent?: number;
  turnTimeoutMs?: number;
}

export interface RunStatus extends RunIdentity {
  phase: 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  agents: AgentStatus[];
}

export interface ExplorationHandle {
  id: string;
  done: Promise<RunStatus>;
  stop(): Promise<RunStatus>;
  getStatus(): RunStatus;
}

export interface AgentManagerOptions {
  database?: ExplorationDatabase;
  harness?: CodingHarness;
}

interface ActiveRun {
  status: RunStatus;
  abort: AbortController;
  done: Promise<RunStatus>;
}

const lenses = [
  'Identify definitions, containment, and structural entry points.',
  'Trace imports, calls, and package dependencies.',
  'Trace service boundaries and communication contracts.',
  'Trace deployment, containers, and configuration relationships.',
];

function integer(value: number, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function shuffled(files: string[], seed: number) {
  let state = seed || 0x9e3779b9;
  for (let i = files.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [files[i], files[j]] = [files[j], files[i]];
  }
  return files;
}

export class AgentManager {
  private readonly database: ExplorationDatabase;
  private readonly harness: CodingHarness;
  private readonly runs = new Map<string, ActiveRun>();

  constructor(options: AgentManagerOptions = {}) {
    this.database = options.database ?? new MemoryExplorationDatabase();
    this.harness = options.harness ?? new CodexHarness();
  }

  async start(options: StartExploration): Promise<ExplorationHandle> {
    const agentCount = integer(options.agentCount ?? 4, 'agentCount', 1, 32);
    const seed = integer(options.seed ?? randomBytes(4).readUInt32LE(), 'seed', 0, 0xffffffff);
    const maxTurns = integer(options.maxTurnsPerAgent ?? 4, 'maxTurnsPerAgent', 1, 32);
    const turnTimeoutMs = integer(options.turnTimeoutMs ?? 180_000, 'turnTimeoutMs', 1, 1_200_000);
    const root = await repositoryRoot(options.repositoryPath);
    const [indexed, skill] = await Promise.all([
      indexSources(root),
      readFile(new URL('./explorer/SKILL.md', import.meta.url), 'utf8'),
    ]);
    if (!indexed.length) throw new Error('The repository has no supported source files to explore');
    const files = shuffled(indexed, seed);
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const run: RunIdentity = { id: runId, repositoryPath: root, seed };
    const agents: AgentStatus[] = [];
    const tasks: ExplorationTask[] = [];
    for (let index = 0; index < agentCount; index++) {
      const id = `agent-${index + 1}`;
      const startPath = files[index % files.length];
      agents.push({
        id, sessionId: randomUUID(), seed: (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0,
        startPath, phase: 'queued', turns: 0, updatedAt: startedAt,
      });
      tasks.push({
        id: stableId('initial', id, startPath), path: startPath,
        question: lenses[(index + seed % lenses.length) % lenses.length],
      });
    }
    await this.database.initializeRun(run, tasks);
    const abort = new AbortController();
    const status: RunStatus = { ...run, startedAt, phase: 'running', agents };
    const workers = agents.map((agent, index) => runExplorer({
      scope: { runId, agentId: agent.id, sessionId: agent.sessionId },
      initialStatus: agent, initialTaskId: tasks[index].id, repositoryPath: root, skill,
      harness: this.harness, database: this.database, signal: abort.signal, maxTurns, turnTimeoutMs,
      onStatus: latest => { status.agents[index] = latest; },
    }));
    const done = Promise.all(workers).then(results => {
      status.phase = results.some(result => result.phase === 'failed') ? 'failed' : abort.signal.aborted ? 'stopped' : 'completed';
      status.finishedAt = new Date().toISOString();
      return structuredClone(status);
    });
    this.runs.set(runId, { status, abort, done });
    return { id: runId, done, stop: () => this.stop(runId), getStatus: () => this.getStatus(runId) };
  }

  getStatus(runId: string): RunStatus {
    return structuredClone(this.getRun(runId).status);
  }

  getContext(runId: string) {
    this.getRun(runId);
    return this.database.readContext(runId);
  }

  async stop(runId: string): Promise<RunStatus> {
    const run = this.getRun(runId);
    if (run.status.phase === 'running') {
      run.status.phase = 'stopping';
      run.abort.abort(new Error('Exploration stopped'));
    }
    return structuredClone(await run.done);
  }

  private getRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown exploration run: ${runId}`);
    return run;
  }
}
