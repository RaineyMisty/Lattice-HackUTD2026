import { basename } from 'node:path';
import { worldConnection, worldQueries, type DbConnection, type WorldConnectionConfig } from '../../../spacetime_db/client/index.ts';
import type {
  ActivityRecord, AgentScope, AgentStatus, DiscoveryBatch, ExplorationContext, ExplorationDatabase,
  ExplorationTask, RunIdentity, TaskClaim, WorldKnowledge, WorldUpdate,
} from './interface.ts';

export interface SpacetimeExplorationOptions extends WorldConnectionConfig {
  worldId: string;
  createWorld?: boolean;
}

interface Connection {
  client: DbConnection;
  listeners: Set<() => void>;
}
interface Worker {
  connection: Connection;
  claim?: { taskId: string; attempt: number };
}
interface Run {
  control: Connection;
  workers: Map<string, Worker>;
  preferred: Map<string, string>;
  agents: Map<string, AgentStatus>;
  activity: ActivityRecord[];
  final?: WorldKnowledge;
}

function open(options: SpacetimeExplorationOptions, token?: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const timer = setTimeout(() => fail(new Error('Timed out subscribing to SpacetimeDB')), 15_000);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
      client.disconnect();
    };
    const client = worldConnection({ ...options, token })
      .onConnect(client => {
        client.db.worldFrontier.onInsert(notify);
        client.db.worldFrontier.onUpdate(notify);
        client.db.worldFrontier.onDelete(notify);
        client.db.myMemberships.onInsert(notify);
        client.db.myMemberships.onUpdate(notify);
        client.subscriptionBuilder()
          .onError(ctx => fail(new Error(`World subscription failed: ${String(ctx.event)}`)))
          .onApplied(() => { clearTimeout(timer); resolve({ client, listeners }); })
          .subscribe(worldQueries(options.worldId));
      })
      .onConnectError((_context, error) => fail(error))
      .onDisconnect(() => {
        clearTimeout(timer);
        reject(new Error('SpacetimeDB disconnected'));
        notify();
      })
      .build();
  });
}

function snapshot(client: DbConnection): WorldKnowledge {
  return {
    entities: [...client.db.worldEntities.iter()],
    relations: [...client.db.worldRelations.iter()],
    behaviors: [...client.db.worldBehaviors.iter()],
    evidence: [...client.db.worldEvidence.iter()],
    frontier: [...client.db.worldFrontier.iter()],
  };
}

function assertConnected(client: DbConnection) {
  if (!client.isActive) throw new Error('SpacetimeDB disconnected');
}

function waitForCache<T>(connection: Connection, read: () => T | undefined, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${label}`)); }, 8000);
    const cleanup = () => { clearTimeout(timer); connection.listeners.delete(check); };
    const check = () => {
      if (!connection.client.isActive) {
        cleanup();
        reject(new Error('SpacetimeDB disconnected'));
        return;
      }
      const value = read();
      if (value !== undefined) {
        cleanup();
        resolve(value);
      }
    };
    connection.listeners.add(check);
    check();
  });
}

export class SpacetimeExplorationDatabase implements ExplorationDatabase {
  readonly commitBound = true;
  private readonly runs = new Map<string, Run>();

  constructor(private readonly options: SpacetimeExplorationOptions) {}

  async initializeRun(run: RunIdentity, tasks: readonly ExplorationTask[], agents: readonly AgentStatus[] = []) {
    const { worldId } = this.options;
    if (!run.commit) throw new Error('A Git revision is required for the live world');
    const control = await open(this.options, this.options.token);
    const state: Run = { control, workers: new Map(), preferred: new Map(), agents: new Map(), activity: [] };
    try {
      const { client } = control;
      const world = client.db.myWorlds.id.find(worldId);
      if (world && world.commit !== run.commit) throw new Error(`World commit ${world.commit} differs from checkout ${run.commit}`);
      if (!world) {
        if (!this.options.createWorld) throw new Error('World is missing or inaccessible. Use --create-world with the publisher identity for a new world.');
        await client.reducers.createWorld({ id: worldId, repository: basename(run.repositoryPath), commit: run.commit });
      }
      const readRole = (client: DbConnection) => [...client.db.myMemberships.iter()].find(row => row.worldId === worldId)?.role;
      const role = world ? readRole(client) : await waitForCache(control, () => readRole(client), 'owner membership');
      if (role !== 'owner' && (role !== 'agent' || agents.length !== 1)) {
        throw new Error('Use the world owner for parallel workers, or an Agent identity with --agents 1');
      }
      for (const task of tasks) state.preferred.set(task.id, JSON.stringify([worldId, task.path, task.question]));
      const frontier = new Map([...client.db.worldFrontier.iter()].map(task => [task.id, task.status]));
      const newSeeds = tasks.filter(task => !frontier.has(state.preferred.get(task.id)!));
      if (newSeeds.length && ![...frontier.values()].some(status => status === 'queued' || status === 'leased')) {
        await client.reducers.submitDiscovery({
          worldId, entities: [], relations: [], behaviors: [],
          tasks: newSeeds.map(({ path, question }) => ({ path, question })), completes: undefined,
        });
      }
      // Each Explorer uses its own subscribed cache and claim identity.
      for (const agent of agents) {
        const connection = role === 'agent' ? control : await open(this.options);
        state.workers.set(agent.id, { connection });
        if (connection !== control) {
          await client.reducers.setMember({ worldId, identity: connection.client.identity!, role: 'agent' });
          await waitForCache(connection, () => readRole(connection.client), 'Agent membership');
        }
      }
      this.runs.set(run.id, state);
    } catch (error) {
      this.disconnect(state);
      throw error;
    }
  }

  async readContext(runId: string, _limit?: number, signal?: AbortSignal, scope?: AgentScope): Promise<ExplorationContext> {
    signal?.throwIfAborted();
    const state = this.run(runId);
    const client = scope ? this.worker(scope).connection.client : state.control.client;
    if (!state.final) assertConnected(client);
    const world = state.final ?? snapshot(client);
    return {
      nodes: [], edges: [], evidence: [], tasks: [],
      agents: [...state.agents.values()], activity: [...state.activity], world,
    };
  }

  async claimTask(scope: AgentScope, preferredId?: string, signal?: AbortSignal, leaseMs = 195_000): Promise<TaskClaim> {
    const worker = this.worker(scope);
    const { client } = worker.connection;
    assertConnected(client);
    signal?.throwIfAborted();
    const initial = this.run(scope.runId).preferred;
    const preferred = preferredId && initial.get(preferredId);
    const initialIds = new Set(initial.values());
    const queued = [...client.db.worldFrontier.iter()].filter(row => row.status === 'queued');
    queued.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)
      || Number(initialIds.has(a.id)) - Number(initialIds.has(b.id)) || a.attempt - b.attempt);
    for (const task of queued) {
      signal?.throwIfAborted();
      try {
        await client.reducers.claimTask({ worldId: this.options.worldId, taskId: task.id, leaseMs });
      } catch (error) {
        if (String(error).includes('Task is no longer available')) continue;
        throw error;
      }
      const leased = await waitForCache(worker.connection, () => {
        const row = client.db.worldFrontier.id.find(task.id);
        return row?.status === 'leased' && row.claimant?.equals(client.identity!) ? row : undefined;
      }, 'the claimed Frontier row');
      worker.claim = { taskId: task.id, attempt: leased.attempt };
      return { task: { id: task.id, path: task.path, question: task.question }, inFlight: 0 };
    }
    const inFlight = [...client.db.worldFrontier.iter()].filter(row => row.status === 'leased').length;
    return { task: null, inFlight };
  }

  waitForWork(scope: AgentScope, stayOpen: boolean, signal: AbortSignal): Promise<void> {
    const { client, listeners } = this.worker(scope).connection;
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        listeners.delete(changed);
        signal.removeEventListener('abort', stopped);
        if (error) reject(error);
        else resolve();
      };
      const stopped = () => finish(signal.reason);
      const changed = () => {
        if (!client.isActive) return finish(new Error('SpacetimeDB disconnected'));
        const rows = [...client.db.worldFrontier.iter()];
        if (rows.some(row => row.status === 'queued') || (!stayOpen && !rows.some(row => row.status === 'leased'))) finish();
      };
      listeners.add(changed);
      signal.addEventListener('abort', stopped, { once: true });
      if (signal.aborted) stopped();
      else changed();
    });
  }

  async enqueueTasks(runId: string, tasks: readonly ExplorationTask[]) {
    const { client } = this.run(runId).control;
    const scheduled = new Set([...client.db.worldFrontier.iter()].map(row => row.path));
    const pending = tasks.filter(task => !scheduled.has(task.path)).map(({ path, question }) => ({ path, question }));
    if (!pending.length) return false;
    await client.reducers.submitDiscovery({
      worldId: this.options.worldId, entities: [], relations: [], behaviors: [], tasks: pending, completes: undefined,
    });
    return true;
  }

  async publishDiscovery(scope: AgentScope, taskId: string, update: WorldUpdate, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const worker = this.worker(scope);
    if (worker.claim?.taskId !== taskId) throw new Error('Expected an active exploration claim');
    await worker.connection.client.reducers.submitDiscovery({ worldId: this.options.worldId, ...update, completes: undefined });
  }

  async commitDiscovery(scope: AgentScope, taskId: string, batch: DiscoveryBatch, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const worker = this.worker(scope);
    if (worker.claim?.taskId !== taskId || !batch.world) throw new Error('Expected a verified world update with an active claim');
    await worker.connection.client.reducers.submitDiscovery({
      worldId: this.options.worldId, ...batch.world, completes: worker.claim,
    });
    worker.claim = undefined;
  }

  async settleTask(scope: AgentScope, taskId: string) {
    const worker = this.worker(scope);
    // The existing database scheduler requeues abandoned claims after their lease.
    if (worker.claim?.taskId === taskId) worker.claim = undefined;
  }

  async writeStatus(scope: AgentScope, status: AgentStatus) {
    this.run(scope.runId).agents.set(scope.agentId, status);
  }

  async appendActivity(scope: AgentScope, activity: ActivityRecord) {
    const entries = this.run(scope.runId).activity;
    entries.push(activity);
    if (entries.length > 200) entries.shift();
  }

  async closeRun(runId: string) {
    const state = this.run(runId);
    state.final = snapshot(state.control.client);
    this.disconnect(state);
  }

  private run(id: string) {
    const state = this.runs.get(id);
    if (!state) throw new Error('Unknown exploration run');
    return state;
  }

  private worker(scope: AgentScope) {
    const worker = this.run(scope.runId).workers.get(scope.agentId);
    if (!worker) throw new Error('Unknown Explorer identity');
    return worker;
  }

  private disconnect(state: Run) {
    const connections = new Set([state.control, ...[...state.workers.values()].map(worker => worker.connection)]);
    for (const { client } of connections) client.disconnect();
  }
}
