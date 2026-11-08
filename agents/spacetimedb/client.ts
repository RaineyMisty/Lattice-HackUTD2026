import {
  worldConnection, worldQueries, type DbConnection, type WorldConnectionConfig,
  type BehaviorInput, type EntityInput, type Frontier, type RelationInput, type TaskInput,
} from '../../spacetime_db/client/index.ts';

export interface WorldOptions extends WorldConnectionConfig {
  worldId: string;
  createWorld?: boolean;
}
export interface Findings {
  entities: EntityInput[];
  relations: RelationInput[];
  behaviors: BehaviorInput[];
  tasks: TaskInput[];
}
export type Claim = Pick<Frontier, 'id' | 'path' | 'question' | 'attempt'>;
export const emptyFindings = (): Findings => ({ entities: [], relations: [], behaviors: [], tasks: [] });

function connect(options: WorldConnectionConfig, worldId: string) {
  return new Promise<AgentConnection>((resolve, reject) => {
    let session: AgentConnection | undefined;
    const timer = setTimeout(() => fail(new Error('SpacetimeDB connection timed out')), 10_000);
    function fail(error: Error) {
      clearTimeout(timer);
      reject(error);
      client.disconnect();
    }
    const client = worldConnection(options)
      .onConnect(client => {
        clearTimeout(timer);
        session = new AgentConnection(client, worldId);
        resolve(session);
      })
      .onConnectError((_context, error) => fail(error))
      .onDisconnect(() => session?.notify())
      .build();
  });
}

async function subscribe(client: DbConnection, worldId: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SpacetimeDB subscription timed out')), 10_000);
    client.subscriptionBuilder()
      .onApplied(() => { clearTimeout(timer); resolve(); })
      .onError(() => { clearTimeout(timer); reject(new Error('Could not subscribe to repository world')); })
      .subscribe(worldQueries(worldId));
  });
}

export class AgentConnection {
  private revision = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly client: DbConnection, readonly worldId: string) {
    const changed = () => this.notify();
    client.db.worldFrontier.onInsert(changed);
    client.db.worldFrontier.onUpdate(changed);
    client.db.worldFrontier.onDelete(changed);
  }

  notify() {
    this.revision++;
    for (const wake of this.listeners) wake();
  }

  get frontierRevision() { return this.revision; }

  async claim(signal: AbortSignal, leaseMs: number, preferred?: string): Promise<Claim | undefined> {
    if (!this.client.isActive) throw new Error('SpacetimeDB disconnected');
    const queued = [...this.client.db.worldFrontier.iter()].filter(row => row.status === 'queued');
    queued.sort((a, b) => Number(b.path === preferred) - Number(a.path === preferred)
      || Number(a.question === seedQuestion) - Number(b.question === seedQuestion) || a.attempt - b.attempt);
    for (const task of queued) {
      signal.throwIfAborted();
      try {
        await this.client.reducers.claimTask({ worldId: this.worldId, taskId: task.id, leaseMs });
      } catch (error) {
        if (String(error).includes('Task is no longer available')) continue;
        throw error;
      }
      const deadline = AbortSignal.timeout(5000);
      while (true) {
        const version = this.revision;
        const row = this.client.db.worldFrontier.id.find(task.id);
        if (row?.status === 'leased' && row.claimant?.equals(this.client.identity!)) {
          return { id: row.id, path: row.path, question: row.question, attempt: row.attempt };
        }
        await this.wait(version, deadline);
      }
    }
  }

  wait(revision: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.listeners.delete(check);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason);
      const check = () => {
        if (!this.client.isActive) finish(new Error('SpacetimeDB disconnected'));
        else if (this.revision !== revision) finish();
      };
      this.listeners.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  find(query: string) {
    const search = query.toLowerCase();
    return [...this.client.db.worldEntities.iter()].filter(row => row.active
      && (row.symbol.toLowerCase().includes(search) || row.path.toLowerCase().includes(search))).slice(0, 16);
  }

  frontier() {
    return [...this.client.db.worldFrontier.iter()];
  }

  async publish(findings: Findings, claim?: Claim) {
    if (claim) {
      const row = this.client.db.worldFrontier.id.find(claim.id);
      if (row?.status !== 'leased' || row.attempt !== claim.attempt || !row.claimant?.equals(this.client.identity!)
        || !row.deadline || row.deadline.microsSinceUnixEpoch <= BigInt(Date.now()) * 1000n) {
        throw new Error('Exploration task lease expired');
      }
    }
    await this.client.reducers.submitDiscovery({ worldId: this.worldId, ...findings, completes: undefined });
  }

  async finish(claim: Claim) {
    await this.client.reducers.submitDiscovery({
      worldId: this.worldId, ...emptyFindings(), completes: { taskId: claim.id, attempt: claim.attempt },
    });
  }

  async release(claim: Claim, retry: boolean) {
    if (!this.client.isActive) return;
    await this.client.reducers.releaseExplorationTask({
      worldId: this.worldId, taskId: claim.id, attempt: claim.attempt, retry,
    });
  }
}

export const seedQuestion = 'Explore this part of the repository and publish source-backed structure and dependencies.';

export class ExplorationWorld {
  private constructor(readonly control: AgentConnection, readonly agents: AgentConnection[]) {}

  static async open(options: WorldOptions, repository: string, commit: string, count: number) {
    const connections: DbConnection[] = [];
    try {
      const control = await connect(options, options.worldId);
      const owner = control.client;
      connections.push(owner);
      await subscribe(owner, options.worldId);
      const world = owner.db.myWorlds.id.find(options.worldId);
      if (world && world.commit !== commit) throw new Error('The world is pinned to a different Git commit');
      if (!world) {
        if (!options.createWorld) throw new Error('World is missing or inaccessible');
        await owner.reducers.createWorld({ id: options.worldId, repository, commit });
      }
      const role = [...owner.db.myMemberships.iter()].find(row => row.worldId === options.worldId)?.role;
      if (world && role !== 'owner' && (role !== 'agent' || count !== 1)) {
        throw new Error('Parallel exploration requires a world owner token');
      }
      if (role === 'agent') return new ExplorationWorld(control, [control]);
      const agents: AgentConnection[] = [];
      for (let index = 0; index < count; index++) {
        const agent = await connect({ uri: options.uri, database: options.database }, options.worldId);
        const client = agent.client;
        connections.push(client);
        await owner.reducers.setMember({ worldId: options.worldId, identity: client.identity!, role: 'agent' });
        await subscribe(client, options.worldId);
        agents.push(agent);
      }
      return new ExplorationWorld(control, agents);
    } catch (error) {
      for (const client of connections) client.disconnect();
      throw error;
    }
  }

  async replenish(paths: readonly string[], count: number, observer = this.control) {
    const visited = new Set([...this.control.frontier(), ...observer.frontier()].map(task => task.path));
    const pending = paths.filter(path => !visited.has(path)).slice(0, count);
    if (pending.length) {
      await this.control.publish({ ...emptyFindings(), tasks: pending.map(path => ({ path, question: seedQuestion })) });
    }
  }

  summary() {
    const db = this.control.client.db;
    return { entities: db.worldEntities.count(), relations: db.worldRelations.count(), behaviors: db.worldBehaviors.count(),
      queued: [...db.worldFrontier.iter()].filter(row => row.status === 'queued').length };
  }

  close() {
    for (const client of new Set([this.control, ...this.agents].map(agent => agent.client))) client.disconnect();
  }
}
