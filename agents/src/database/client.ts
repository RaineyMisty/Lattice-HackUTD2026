import type {
  ActivityRecord, AgentScope, AgentStatus, DiscoveryBatch, ExplorationContext,
  ExplorationDatabase, ExplorationTask, RunIdentity, TaskClaim, TaskRecord,
} from './interface.ts';

type RunStore = {
  graph: Pick<ExplorationContext, 'nodes' | 'edges' | 'evidence'>;
  tasks: Map<string, TaskRecord & { sessionId?: string }>;
  agents: Map<string, AgentStatus>;
  activity: ActivityRecord[];
};

function mergeById<T extends { id: string; evidenceIds?: string[] }>(existing: T[], additions: T[]) {
  const merged = new Map(existing.map(row => [row.id, row]));
  for (const item of additions) {
    const previous = merged.get(item.id);
    if (!previous) merged.set(item.id, item);
    else if (item.evidenceIds) {
      merged.set(item.id, { ...previous, evidenceIds: [...new Set([...(previous.evidenceIds ?? []), ...item.evidenceIds])] });
    }
  }
  return [...merged.values()];
}

export class MemoryExplorationDatabase implements ExplorationDatabase {
  private readonly runs = new Map<string, RunStore>();

  async initializeRun(run: RunIdentity, tasks: readonly ExplorationTask[]) {
    if (this.runs.has(run.id)) throw new Error(`Exploration run already exists: ${run.id}`);
    this.runs.set(run.id, {
      graph: { nodes: [], edges: [], evidence: [] },
      tasks: new Map(tasks.map(task => [task.id, { ...task, state: 'pending' }])),
      agents: new Map(), activity: [],
    });
  }

  async readContext(runId: string, limit = Infinity, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const run = this.getRun(runId);
    const tail = <T>(items: T[]) => limit === Infinity ? items : items.slice(Math.max(0, items.length - limit));
    return structuredClone({
      nodes: tail(run.graph.nodes), edges: tail(run.graph.edges), evidence: tail(run.graph.evidence),
      tasks: tail([...run.tasks.values()]).map(({ sessionId: _session, ...task }) => task),
      agents: [...run.agents.values()], activity: tail(run.activity),
    });
  }

  async claimTask(scope: AgentScope, preferredId?: string, signal?: AbortSignal): Promise<TaskClaim> {
    signal?.throwIfAborted();
    const tasks = this.getRun(scope.runId).tasks;
    const preferred = preferredId ? tasks.get(preferredId) : undefined;
    const task = preferred?.state === 'pending' ? preferred : [...tasks.values()].find(row => row.state === 'pending');
    if (!task) return { task: null, inFlight: [...tasks.values()].filter(row => row.state === 'claimed').length };
    task.state = 'claimed';
    task.owner = scope.agentId;
    task.sessionId = scope.sessionId;
    return { task: { id: task.id, path: task.path, question: task.question }, inFlight: 0 };
  }

  async commitDiscovery(scope: AgentScope, taskId: string, batch: DiscoveryBatch, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const run = this.getRun(scope.runId);
    const task = run.tasks.get(taskId);
    if (task?.state === 'completed' && task.owner === scope.agentId && task.sessionId === scope.sessionId) return;
    this.requireClaim(task, scope);
    const copy = structuredClone(batch);
    run.graph = {
      nodes: mergeById(run.graph.nodes, copy.nodes),
      edges: mergeById(run.graph.edges, copy.edges),
      evidence: mergeById(run.graph.evidence, copy.evidence),
    };
    for (const next of copy.tasks) if (!run.tasks.has(next.id)) run.tasks.set(next.id, { ...next, state: 'pending' });
    task.state = 'completed';
  }

  async settleTask(scope: AgentScope, taskId: string, outcome: 'release' | 'failed') {
    const task = this.getRun(scope.runId).tasks.get(taskId);
    if (!task || task.state !== 'claimed' || task.sessionId !== scope.sessionId || task.owner !== scope.agentId) return;
    task.state = outcome === 'release' ? 'pending' : 'failed';
    delete task.owner;
    delete task.sessionId;
  }

  async writeStatus(scope: AgentScope, status: AgentStatus) {
    this.getRun(scope.runId).agents.set(scope.agentId, structuredClone(status));
  }

  async appendActivity(scope: AgentScope, activity: ActivityRecord) {
    this.getRun(scope.runId).activity.push(structuredClone(activity));
  }

  private getRun(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown exploration run: ${id}`);
    return run;
  }

  private requireClaim(task: (TaskRecord & { sessionId?: string }) | undefined, scope: AgentScope):
    asserts task is TaskRecord & { sessionId: string } {
    if (!task || task.state !== 'claimed' || task.owner !== scope.agentId || task.sessionId !== scope.sessionId) {
      throw new Error('Exploration task is not claimed by this agent session');
    }
  }
}

/** Bind these operations to generated client views and reducers once the exploration schema exists. */
export interface SpacetimeExplorationBindings {
  readContext: ExplorationDatabase['readContext'];
  /** Implement with an atomic claim reducer and its correlated result, or a transactional procedure. */
  claimTask: ExplorationDatabase['claimTask'];
  reducers: Pick<ExplorationDatabase, 'initializeRun' | 'commitDiscovery' | 'settleTask' | 'writeStatus' | 'appendActivity'>;
}

export class SpacetimeExplorationDatabase implements ExplorationDatabase {
  constructor(private readonly bindings: SpacetimeExplorationBindings) {}
  initializeRun(...args: Parameters<ExplorationDatabase['initializeRun']>) { return this.bindings.reducers.initializeRun(...args); }
  readContext(...args: Parameters<ExplorationDatabase['readContext']>) { return this.bindings.readContext(...args); }
  claimTask(...args: Parameters<ExplorationDatabase['claimTask']>) { return this.bindings.claimTask(...args); }
  commitDiscovery(...args: Parameters<ExplorationDatabase['commitDiscovery']>) { return this.bindings.reducers.commitDiscovery(...args); }
  settleTask(...args: Parameters<ExplorationDatabase['settleTask']>) { return this.bindings.reducers.settleTask(...args); }
  writeStatus(...args: Parameters<ExplorationDatabase['writeStatus']>) { return this.bindings.reducers.writeStatus(...args); }
  appendActivity(...args: Parameters<ExplorationDatabase['appendActivity']>) { return this.bindings.reducers.appendActivity(...args); }
}
