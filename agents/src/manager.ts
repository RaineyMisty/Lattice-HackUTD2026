import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MemoryExplorationDatabase } from './database/client.ts';
import type { ActivityRecord, AgentStatus, ExplorationDatabase, ExplorationTask, RunIdentity } from './database/interface.ts';
import { runExplorer } from './explorer/explorer.ts';
import { CodexHarness } from './explorer/harness.ts';
import type { CodingHarness } from './explorer/harness.ts';
import { indexSources, repositoryRevision, repositoryRoot, stableId } from './explorer/repository.ts';

export interface StartExploration {
  repositoryPath: string;
  agentCount?: number;
  seed?: number;
  maxTurnsPerAgent?: number;
  turnTimeoutMs?: number;
  serviceEntries?: ReadonlyMap<string, string>;
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
  onActivity?(activity: ActivityRecord): void;
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

function nextSeed(seed: number) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}

function shuffled(files: string[], seed: number) {
  let state = seed || 0x9e3779b9;
  for (let i = files.length - 1; i > 0; i--) {
    state = nextSeed(state);
    const j = state % (i + 1);
    [files[i], files[j]] = [files[j], files[i]];
  }
  return files;
}

export class AgentManager {
  private readonly database: ExplorationDatabase;
  private readonly harness: CodingHarness;
  private readonly onActivity?: AgentManagerOptions['onActivity'];
  private readonly runs = new Map<string, ActiveRun>();

  constructor(options: AgentManagerOptions = {}) {
    this.database = options.database ?? new MemoryExplorationDatabase();
    this.harness = options.harness ?? new CodexHarness();
    this.onActivity = options.onActivity;
  }

  async start(options: StartExploration): Promise<ExplorationHandle> {
    const agentCount = integer(options.agentCount ?? 4, 'agentCount', 1, 32);
    const seed = integer(options.seed ?? randomBytes(4).readUInt32LE(), 'seed', 0, 0xffffffff);
    const stayOpen = !!this.database.commitBound && options.maxTurnsPerAgent === undefined;
    const maxTurns = stayOpen ? Infinity : integer(options.maxTurnsPerAgent ?? 4, 'maxTurnsPerAgent', 1, 32);
    const turnTimeoutMs = integer(options.turnTimeoutMs ?? 180_000, 'turnTimeoutMs', 1, 1_200_000);
    const root = await repositoryRoot(options.repositoryPath);
    const [indexed, skill, revision] = await Promise.all([
      options.serviceEntries ? Promise.resolve([...options.serviceEntries.values()]) : indexSources(root),
      readFile(new URL('./explorer/SKILL.md', import.meta.url), 'utf8'),
      this.database.commitBound ? repositoryRevision(root) : undefined,
    ]);
    const files = shuffled(revision ? indexed.filter(file => revision.tracked.has(file) && file.length <= 768) : indexed, seed);
    if (!files.length) throw new Error('The repository has no supported source files to explore');
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const run: RunIdentity = { id: runId, repositoryPath: root, seed, commit: revision?.commit };
    const agents: AgentStatus[] = [];
    const tasks: ExplorationTask[] = options.serviceEntries ? files.map(path => ({
      id: stableId('service-entry', path), path,
      question: 'Verify the service entry and trace its explicit cross-service calls from committed source.',
    })) : [];
    const available = [...tasks];
    const firstTasks: string[] = [];
    for (let index = 0; index < agentCount; index++) {
      const id = `agent-${index + 1}`;
      const agentSeed = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
      const task = options.serviceEntries
        ? available.splice(nextSeed(agentSeed) % Math.max(1, available.length), 1)[0] ?? tasks[index % tasks.length]
        : {
          id: stableId('initial', id, files[index % files.length]), path: files[index % files.length],
          question: revision ? 'Find definitions, dependencies, and executable behavior supported by this source.'
            : lenses[(index + seed % lenses.length) % lenses.length],
        };
      agents.push({
        id, sessionId: randomUUID(), seed: agentSeed, startPath: task.path, phase: 'queued', turns: 0, updatedAt: startedAt,
      });
      if (!options.serviceEntries) tasks.push(task);
      firstTasks.push(task.id);
    }
    await this.database.initializeRun(run, tasks, agents);
    const abort = new AbortController();
    const status: RunStatus = { ...run, startedAt, phase: 'running', agents };
    const workers = agents.map((agent, index) => runExplorer({
      scope: { runId, agentId: agent.id, sessionId: agent.sessionId },
      initialStatus: agent, initialTaskId: firstTasks[index], repositoryPath: root, skill,
      harness: this.harness, database: this.database, signal: abort.signal, maxTurns, turnTimeoutMs, stayOpen, commit: revision?.commit,
      onStatus: latest => { status.agents[index] = latest; },
      onActivity: this.onActivity,
      serviceEntries: options.serviceEntries,
    }));
    const done = Promise.all(workers).then(async results => {
      await this.database.closeRun?.(runId);
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
