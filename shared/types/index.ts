export type AgentId = 'A' | 'B' | 'C' | 'D';
export type SourceKind = 'advisory' | 'dependencies' | 'deployments' | 'ownership';
export type RiskStatus = 'unknown' | 'possible' | 'direct' | 'downstream' | 'unaffected';
export type Priority = 'P0' | 'P1' | 'P2';
export interface SourceRecord { id: string; kind: SourceKind; title: string; body: string; }
export interface VulnerabilityFact { component: string; minVersion: string; maxVersion: string; fixedVersion: string; severity: 'critical' | 'high' | 'medium'; }
export interface Dependency { from: string; to: string; kind: 'service' | 'component'; }
export interface Deployment { assetId: string; component: string; version: string; environment: string; }
export interface Ownership { assetId: string; department: string; owner: string; businessCriticality: 'critical' | 'high' | 'medium'; }
export type EvidencePayload =
  | { kind: 'vulnerability'; vulnerability: VulnerabilityFact }
  | { kind: 'dependencies'; dependencies: Dependency[] }
  | { kind: 'deployments'; deployments: Deployment[] }
  | { kind: 'ownership'; owners: Ownership[] };
export interface Evidence { id: string; agentId: AgentId; sourceId: string; submittedAt: string; payload: EvidencePayload; }
export interface Incident { id: string; title: string; severity: string; injectedAt: string; }
export interface Asset { id: string; name: string; subtitle: string; status: RiskStatus; reason: string; evidenceIds: string[]; version?: string; department?: string; owner?: string; businessCriticality?: Ownership['businessCriticality']; priority?: Priority; impactPath: string[]; }
export interface IncidentTask { id: string; incidentId: string; assetId: string; assetName: string; department: string; owner: string; priority: Priority; title: string; instruction: string; reason: string; evidenceIds: string[]; createdAt: string; }
export interface DepartmentNotification { id: string; taskId: string; department: string; createdAt: string; message: string; }
export interface AgentState { id: AgentId; name: string; role: string; sourceKind: SourceKind; status: 'idle' | 'reading' | 'extracting' | 'submitted' | 'stopped' | 'error'; message: string; evidenceCount: number; updatedAt?: string; }
export interface WorldEvent { id: string; at: string; type: 'incident' | 'agent' | 'evidence' | 'derivation' | 'notification' | 'system'; message: string; agentId?: AgentId; }
export interface WorldSnapshot { schemaVersion: 1; revision: number; incident: Incident | null; sources: SourceRecord[]; evidence: Evidence[]; assets: Asset[]; dependencies: Dependency[]; tasks: IncidentTask[]; notifications: DepartmentNotification[]; agents: AgentState[]; events: WorldEvent[]; startedAt: string | null; agentsStopped: boolean; }
export interface AgentDatabase { readSources(agentId: AgentId): Promise<SourceRecord[]>; submitEvidence(agentId: AgentId, sourceId: string, payload: EvidencePayload): Promise<void>; updateStatus(agentId: AgentId, status: AgentState['status'], message: string): Promise<void>; }
