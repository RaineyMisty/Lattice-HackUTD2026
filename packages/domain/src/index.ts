import { AGENT_SOURCE, type AgentId, type Asset, type Evidence, type EvidencePayload, type IncidentTask, type WorldEvent, type WorldSnapshot } from '../../contracts/src/index';
import { AGENT_CATALOG, ASSET_CATALOG, DEMO_SOURCES } from './seed';
export { AGENT_CATALOG, ASSET_CATALOG, DEMO_SOURCES } from './seed';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const unique = (values: string[]) => [...new Set(values)];
const isoNow = () => new Date().toISOString();
const knownAssets = new Set(ASSET_CATALOG.map(asset => asset.id));
const expectedKind: Record<AgentId, EvidencePayload['kind']> = { A: 'vulnerability', B: 'dependencies', C: 'deployments', D: 'ownership' };
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  ensure(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `Only fields ${keys.join(', ')} are accepted`);
}
function text(value: unknown): asserts value is string { ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= 300, 'Expected nonempty text (up to 300 characters)'); }
function list(value: unknown): asserts value is unknown[] { ensure(Array.isArray(value) && value.length > 0 && value.length <= 64, 'Expected 1–64 records'); }
export function parseVersion(value: string): number[] {
  ensure(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'Versions must use stable MAJOR.MINOR.PATCH format');
  const parts = value.split('.').map(Number);
  ensure(parts.every(Number.isSafeInteger), 'Version segment is too large');
  return parts;
}
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}
export function validateEvidence(agentId: AgentId, payload: unknown): asserts payload is EvidencePayload {
  ensure(Object.hasOwn(expectedKind, agentId), 'Unknown agent');
  ensure(payload !== null && typeof payload === 'object', 'Evidence must be an object');
  const data = payload as Record<string, unknown>;
  ensure(data.kind === expectedKind[agentId], `Agent ${agentId} cannot submit this evidence kind`);
  if (data.kind === 'vulnerability') {
    object(data, ['kind', 'vulnerability']);
    object(data.vulnerability, ['component', 'minVersion', 'maxVersion', 'fixedVersion', 'severity']);
    const v = data.vulnerability;
    text(v.component); text(v.minVersion); text(v.maxVersion); text(v.fixedVersion);
    ensure(['critical', 'high', 'medium'].includes(String(v.severity)), 'Invalid severity');
    ensure(compareVersions(v.minVersion, v.maxVersion) <= 0, 'Invalid affected version range');
    ensure(compareVersions(v.fixedVersion, v.maxVersion) > 0, 'Fixed version must follow affected range');
  } else if (data.kind === 'dependencies') {
    object(data, ['kind', 'dependencies']); list(data.dependencies);
    const keys = new Set<string>();
    for (const edge of data.dependencies) {
      object(edge, ['from', 'to', 'kind']); text(edge.from); text(edge.to);
      ensure(knownAssets.has(edge.from), 'Unknown dependent asset');
      ensure(edge.kind === 'service' || edge.kind === 'component', 'Invalid dependency kind');
      ensure(edge.kind === 'service' ? knownAssets.has(edge.to) : edge.to === 'tokengate', 'Unknown dependency target');
      ensure(edge.from !== edge.to, 'Self-dependencies are invalid');
      const key = `${edge.from}:${edge.to}`; ensure(!keys.has(key), 'Duplicate dependency'); keys.add(key);
    }
  } else if (data.kind === 'deployments') {
    object(data, ['kind', 'deployments']); list(data.deployments);
    const keys = new Set<string>();
    for (const deployment of data.deployments) {
      object(deployment, ['assetId', 'component', 'version', 'environment']);
      text(deployment.assetId); text(deployment.component); text(deployment.version); text(deployment.environment);
      ensure(knownAssets.has(deployment.assetId), 'Unknown deployed asset'); parseVersion(deployment.version);
      const key = `${deployment.assetId}:${deployment.component.toLowerCase()}:${deployment.environment.toLowerCase()}`;
      ensure(!keys.has(key), 'Conflicting or duplicate deployment'); keys.add(key);
    }
  } else {
    object(data, ['kind', 'owners']); list(data.owners);
    const keys = new Set<string>();
    for (const ownership of data.owners) {
      object(ownership, ['assetId', 'department', 'owner', 'businessCriticality']);
      text(ownership.assetId); text(ownership.department); text(ownership.owner);
      ensure(knownAssets.has(ownership.assetId), 'Unknown owned asset');
      ensure(['critical', 'high', 'medium'].includes(String(ownership.businessCriticality)), 'Invalid business importance');
      ensure(!keys.has(ownership.assetId), 'Duplicate ownership'); keys.add(ownership.assetId);
    }
  }
}
export function createInitialWorld(): WorldSnapshot {
  return { schemaVersion: 1, revision: 0, mode: 'local', incident: null,
    sources: clone(DEMO_SOURCES.filter(source => source.kind !== 'advisory')), evidence: [],
    assets: ASSET_CATALOG.map(asset => ({ ...asset, status: 'unknown', reason: 'Awaiting investigation evidence', evidenceIds: [], impactPath: [] })),
    dependencies: [], tasks: [], notifications: [], agents: clone(AGENT_CATALOG), events: [], startedAt: null, agentsStopped: false };
}
function event(world: WorldSnapshot, type: WorldEvent['type'], message: string, at: string, agentId?: AgentId) {
  world.events.push({ id: `event-${world.revision}-${world.events.length}`, type, message, at, ...(agentId ? { agentId } : {}) });
  world.events = world.events.slice(-160);
}
export function injectIncident(previous: WorldSnapshot, now = isoNow()): WorldSnapshot {
  if (previous.incident) return clone(previous);
  const world = clone(previous); world.revision++;
  world.incident = { id: 'DEMO-SEC-001', title: 'TokenGate Authentication Bypass', severity: 'critical', injectedAt: now };
  world.sources = clone(DEMO_SOURCES); world.startedAt = now; world.agentsStopped = false;
  event(world, 'incident', 'DEMO-SEC-001 injected. Raw advisory available for investigation.', now);
  return world;
}
export function submitEvidence(previous: WorldSnapshot, agentId: AgentId, sourceId: string, payload: EvidencePayload, now = isoNow()): WorldSnapshot {
  ensure(previous.incident, 'Inject an incident before submitting evidence');
  validateEvidence(agentId, payload);
  const source = previous.sources.find(row => row.id === sourceId);
  ensure(source && source.kind === AGENT_SOURCE[agentId], `Agent ${agentId} cannot submit evidence for this source`);
  const id = `evidence-${agentId}`;
  const existing = previous.evidence.find(row => row.id === id);
  if (existing && JSON.stringify(existing.payload) === JSON.stringify(payload)) {
    const world = clone(previous);
    const agent = world.agents.find(row => row.id === agentId)!;
    if (agent.status !== 'submitted') {
      world.revision++;
      Object.assign(agent, { status: 'submitted', evidenceCount: 1, updatedAt: now, message: `${payload.kind} evidence already committed` });
      event(world, 'agent', `Agent ${agentId} verified its existing evidence. No duplicate records created.`, now, agentId);
    }
    return world;
  }
  const world = clone(previous); world.revision++;
  world.evidence = world.evidence.filter(row => row.id !== id);
  world.evidence.push({ id, agentId, sourceId, payload: clone(payload), submittedAt: now });
  world.evidence.sort((a, b) => a.id.localeCompare(b.id));
  world.agents = world.agents.map(agent => agent.id === agentId ? { ...agent, status: 'submitted', evidenceCount: 1, updatedAt: now, message: `${payload.kind} evidence committed` } : agent);
  event(world, 'evidence', `Agent ${agentId} submitted ${payload.kind} evidence. Database rules evaluated.`, now, agentId);
  return deriveWorld(world, now);
}

/** Pure transaction logic. Called inside submit_evidence's SpacetimeDB reducer.
 * No agent, HTTP route, or browser is allowed to submit these derived records. */
export function deriveWorld(previous: WorldSnapshot, now = isoNow()): WorldSnapshot {
  const world = clone(previous);
  const facts = <K extends EvidencePayload['kind']>(kind: K) => world.evidence.find(row => row.payload.kind === kind) as (Evidence & { payload: Extract<EvidencePayload, { kind: K }> }) | undefined;
  const v = facts('vulnerability'), d = facts('dependencies'), p = facts('deployments'), o = facts('ownership');
  const vulnerability = v?.payload.vulnerability;
  const edges = d?.payload.dependencies ?? [];
  const deployments = p?.payload.deployments ?? [];
  const owners = o?.payload.owners ?? [];
  world.dependencies = clone(edges);
  world.assets = ASSET_CATALOG.map(base => {
    const owner = owners.find(row => row.assetId === base.id);
    const asset: Asset = { ...base, status: 'unknown', reason: 'Awaiting investigation evidence', evidenceIds: [], impactPath: [], ...(owner ? { department: owner.department, owner: owner.owner, businessCriticality: owner.businessCriticality } : {}) };
    const deployment = deployments.find(row => row.assetId === asset.id && row.environment.toLowerCase() === 'production' && (!vulnerability || row.component.toLowerCase() === vulnerability.component.toLowerCase()));
    if (deployment) asset.version = deployment.version;
    if (vulnerability && deployment) {
      const affected = compareVersions(deployment.version, vulnerability.minVersion) >= 0 && compareVersions(deployment.version, vulnerability.maxVersion) <= 0;
      asset.status = affected ? 'direct' : 'unaffected';
      asset.reason = affected ? `Production deploys vulnerable ${vulnerability.component} ${deployment.version}` : `Production deploys ${vulnerability.component} ${deployment.version}, outside the affected range`;
      asset.evidenceIds = [v!.id, p!.id]; asset.impactPath = affected ? [asset.id] : [];
    } else if (vulnerability && edges.some(edge => edge.from === asset.id && edge.kind === 'component' && edge.to.toLowerCase() === vulnerability.component.toLowerCase())) {
      asset.status = 'possible'; asset.reason = `Uses ${vulnerability.component}; production version still unknown`;
      asset.evidenceIds = [v!.id, d!.id];
    }
    return asset;
  });
  // Fixed-point propagation is bounded and deterministic, including cyclic graphs.
  // Reachability from a direct asset is enough; cycles never manufacture a root.
  const direct = world.assets.filter(asset => asset.status === 'direct');
  for (const root of direct) {
    const queue: Array<{ id: string; path: string[] }> = [{ id: root.id, path: [root.id] }];
    const visited = new Set([root.id]);
    while (queue.length) {
      const next = queue.shift()!;
      for (const edge of edges.filter(edge => edge.kind === 'service' && edge.to === next.id).sort((a, b) => a.from.localeCompare(b.from))) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        const asset = world.assets.find(row => row.id === edge.from)!;
        const path = [asset.id, ...next.path];
        if (asset.status !== 'direct' && (asset.status !== 'downstream' || path.length < asset.impactPath.length)) {
          asset.status = 'downstream'; asset.impactPath = path;
          asset.reason = `Depends on affected ${root.name}${path.length > 2 ? ' through a transitive dependency' : ''}; verification required`;
          asset.evidenceIds = unique([...root.evidenceIds, d!.id]);
        }
        queue.push({ id: asset.id, path });
      }
    }
  }
  for (let pass = 0; pass < world.assets.length; pass++) {
    for (const edge of edges.filter(edge => edge.kind === 'service')) {
      const asset = world.assets.find(row => row.id === edge.from)!;
      const dependency = world.assets.find(row => row.id === edge.to)!;
      if (asset.status === 'unknown' && dependency.status === 'possible') {
        asset.status = 'possible'; asset.reason = `Depends on ${dependency.name}; awaiting confirmed production version`;
        asset.evidenceIds = unique([...dependency.evidenceIds, d!.id]);
      }
    }
  }
  const oldTasks = new Map(world.tasks.map(task => [task.id, task]));
  const tasks: IncidentTask[] = [];
  for (const asset of world.assets) {
    const old = previous.assets.find(row => row.id === asset.id);
    if (old?.status !== asset.status) event(world, 'derivation', `${asset.name} → ${asset.status}. ${asset.reason}`, now);
    if (!world.incident || !vulnerability || !asset.department || !o || !['direct', 'downstream'].includes(asset.status)) continue;
    const downstreamCount = world.assets.filter(row => row.status === 'downstream' && row.impactPath.includes(asset.id)).length;
    asset.priority = asset.status === 'direct'
      ? vulnerability.severity === 'critical' && (asset.businessCriticality === 'critical' || downstreamCount > 0) ? 'P0' : 'P1'
      : asset.businessCriticality === 'medium' ? 'P2' : 'P1';
    const id = `${world.incident.id}:${asset.id}`;
    const root = world.assets.find(row => row.id === asset.impactPath.at(-1));
    tasks.push({ id, incidentId: world.incident.id, assetId: asset.id, assetName: asset.name,
      department: asset.department, owner: asset.owner!, priority: asset.priority,
      title: asset.status === 'direct' ? `Upgrade ${asset.name}` : `Verify ${asset.name}`,
      instruction: asset.status === 'direct'
        ? `Upgrade ${asset.name} to ${vulnerability.component} ${vulnerability.fixedVersion} and validate authentication behavior.`
        : `Verify ${asset.name}'s dependency on ${root?.name ?? 'the affected service'}. Check authentication entry points and critical business flows.`,
      reason: asset.reason, evidenceIds: unique([...asset.evidenceIds, o.id]), createdAt: oldTasks.get(id)?.createdAt ?? now });
  }
  world.tasks = tasks;
  world.notifications = tasks.map(task => ({ id: `notification:${task.id}`, taskId: task.id, department: task.department, createdAt: task.createdAt, message: `${task.priority} · ${task.title}. ${task.reason}` }));
  for (const task of tasks) if (!oldTasks.has(task.id)) event(world, 'notification', `${task.priority} task assigned to ${task.department}: ${task.title}`, now);
  return world;
}
