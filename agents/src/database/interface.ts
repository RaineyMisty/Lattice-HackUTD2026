export const nodeKinds = ['service', 'module', 'file', 'symbol', 'container', 'config', 'package'] as const;
export const relationshipKinds = ['contains', 'defines', 'imports', 'calls', 'depends-on', 'communicates-with', 'deploys', 'configures'] as const;
export type NodeKind = typeof nodeKinds[number];
export type RelationshipKind = typeof relationshipKinds[number];

export interface NodeRef {
  kind: NodeKind;
  name: string;
  path: string;
}

export interface SourceEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
  verification: 'source-matched';
}

export interface DiscoveryNode extends NodeRef {
  id: string;
  evidenceIds: string[];
  agentId: string;
}

export interface DiscoveryEdge {
  id: string;
  fromId: string;
  toId: string;
  relationship: RelationshipKind;
  evidenceIds: string[];
  agentId: string;
}

export interface ExplorationTask {
  id: string;
  path: string;
  question: string;
}

export interface TaskRecord extends ExplorationTask {
  state: 'pending' | 'claimed' | 'completed' | 'failed';
  owner?: string;
}

export interface AgentStatus {
  id: string;
  sessionId: string;
  seed: number;
  startPath: string;
  phase: 'queued' | 'running' | 'waiting' | 'completed' | 'stopped' | 'failed';
  turns: number;
  updatedAt: string;
  taskId?: string;
  error?: string;
}

export interface ActivityRecord {
  at: string;
  agentId: string;
  kind: 'lifecycle' | 'task' | 'tool' | 'verification';
  message: string;
  taskId?: string;
}

export interface RunIdentity { id: string; repositoryPath: string; seed: number }
export interface AgentScope { runId: string; agentId: string; sessionId: string }

export interface ExplorationContext {
  nodes: DiscoveryNode[];
  edges: DiscoveryEdge[];
  evidence: SourceEvidence[];
  tasks: TaskRecord[];
  agents: AgentStatus[];
  activity: ActivityRecord[];
}

export interface DiscoveryBatch {
  nodes: DiscoveryNode[];
  edges: DiscoveryEdge[];
  evidence: SourceEvidence[];
  tasks: ExplorationTask[];
}

export interface TaskClaim {
  task: ExplorationTask | null;
  inFlight: number;
}

export interface ExplorationDatabase {
  initializeRun(run: RunIdentity, tasks: readonly ExplorationTask[]): Promise<void>;
  readContext(runId: string, limit?: number, signal?: AbortSignal): Promise<ExplorationContext>;
  /** Claim and count in-flight work atomically. A claim belongs to one agent session. */
  claimTask(scope: AgentScope, preferredId?: string, signal?: AbortSignal): Promise<TaskClaim>;
  /** Save all findings and complete the claim atomically. A retry must not duplicate records. */
  commitDiscovery(scope: AgentScope, taskId: string, batch: DiscoveryBatch, signal?: AbortSignal): Promise<void>;
  settleTask(scope: AgentScope, taskId: string, outcome: 'release' | 'failed'): Promise<void>;
  writeStatus(scope: AgentScope, status: AgentStatus): Promise<void>;
  appendActivity(scope: AgentScope, activity: ActivityRecord): Promise<void>;
}
