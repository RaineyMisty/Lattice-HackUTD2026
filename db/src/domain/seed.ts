import type { Asset, AgentState, SourceRecord } from '../../../shared/types/index';

// Raw fixture documents, not precomputed risk results. Each agent receives one.
export const DEMO_SOURCES: SourceRecord[] = [
  { id: 'source-advisory', kind: 'advisory', title: 'DEMO-SEC-001 · Security advisory', body: JSON.stringify({ kind: 'vulnerability', vulnerability: { component: 'TokenGate', minVersion: '1.8.0', maxVersion: '1.8.2', fixedVersion: '1.8.3', severity: 'critical' } }, null, 2) },
  { id: 'source-dependencies', kind: 'dependencies', title: 'ASTER · Software dependency inventory', body: JSON.stringify({ kind: 'dependencies', dependencies: [{ from: 'auth', to: 'tokengate', kind: 'component' }, { from: 'reporting', to: 'tokengate', kind: 'component' }, { from: 'checkout', to: 'auth', kind: 'service' }, { from: 'merchant', to: 'auth', kind: 'service' }] }, null, 2) },
  { id: 'source-deployments', kind: 'deployments', title: 'ASTER · Production release manifest', body: JSON.stringify({ kind: 'deployments', deployments: [{ assetId: 'auth', component: 'TokenGate', version: '1.8.1', environment: 'production' }, { assetId: 'reporting', component: 'TokenGate', version: '1.8.3', environment: 'production' }] }, null, 2) },
  { id: 'source-ownership', kind: 'ownership', title: 'ASTER · Asset ownership register', body: JSON.stringify({ kind: 'ownership', owners: [{ assetId: 'auth', department: 'Security / Identity Team', owner: 'Maya Chen', businessCriticality: 'critical' }, { assetId: 'checkout', department: 'Commerce Engineering', owner: 'James Park', businessCriticality: 'critical' }, { assetId: 'merchant', department: 'Merchant Platform Team', owner: 'Alex Rivera', businessCriticality: 'high' }, { assetId: 'reporting', department: 'Finance Systems', owner: 'Sam Taylor', businessCriticality: 'medium' }] }, null, 2) },
];

export const ASSET_CATALOG: Pick<Asset, 'id' | 'name' | 'subtitle'>[] = [
  { id: 'auth', name: 'Auth Service', subtitle: 'Identity & access' },
  { id: 'checkout', name: 'Checkout', subtitle: 'Payments & orders' },
  { id: 'merchant', name: 'Merchant Portal', subtitle: 'Partner operations' },
  { id: 'reporting', name: 'Reporting', subtitle: 'Financial analytics' },
];

export const AGENT_CATALOG: AgentState[] = [
  { id: 'A', name: 'Agent A', role: 'Vulnerability Analyst', sourceKind: 'advisory', status: 'idle', message: 'Waiting for incident', evidenceCount: 0 },
  { id: 'B', name: 'Agent B', role: 'Dependency Analyst', sourceKind: 'dependencies', status: 'idle', message: 'Waiting for incident', evidenceCount: 0 },
  { id: 'C', name: 'Agent C', role: 'Deployment Analyst', sourceKind: 'deployments', status: 'idle', message: 'Waiting for incident', evidenceCount: 0 },
  { id: 'D', name: 'Agent D', role: 'Ownership Analyst', sourceKind: 'ownership', status: 'idle', message: 'Waiting for incident', evidenceCount: 0 },
];
