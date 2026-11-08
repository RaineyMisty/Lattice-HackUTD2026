import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorldSnapshot } from '../../../packages/contracts/src/index.js';
import { createInitialWorld } from '../../../packages/domain/src/index.js';

/** Persistence belongs to the database simulator, never to the agents or UI. */
export class PersistentWorld {
  private world: WorldSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(world: WorldSnapshot) => void>();
  private constructor(private readonly directory: string, initial: WorldSnapshot) { this.world = initial; }

  static async open(directory: string): Promise<PersistentWorld> {
    await mkdir(directory, { recursive: true });
    let initial: WorldSnapshot;
    try {
      initial = JSON.parse(await readFile(join(directory, 'world.json'), 'utf8')) as WorldSnapshot;
      if (initial.schemaVersion !== 1 || !Array.isArray(initial.assets) || !Array.isArray(initial.evidence)
        || !Array.isArray(initial.agents) || !Array.isArray(initial.tasks) || !Array.isArray(initial.notifications)) {
        throw new Error('Unsupported persistent world schema. Back up .data/world.json before resetting it.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      initial = createInitialWorld();
    }
    const store = new PersistentWorld(directory, initial);
    // An interrupted process must not leave fictitious live workers on the dashboard.
    if (initial.agents.some(agent => ['reading', 'extracting'].includes(agent.status))) {
      await store.transact(world => ({ ...world, agentsStopped: true, agents: world.agents.map(agent =>
        ['reading', 'extracting'].includes(agent.status)
          ? { ...agent, status: 'stopped' as const, message: 'Runtime restarted; persisted evidence retained' } : agent),
      }));
    }
    return store;
  }

  snapshot(): WorldSnapshot { return structuredClone(this.world); }
  subscribe(listener: (world: WorldSnapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async transact(mutator: (world: WorldSnapshot) => WorldSnapshot): Promise<WorldSnapshot> {
    const task = this.queue.then(async () => {
      const next = mutator(structuredClone(this.world));
      next.revision = Math.max(this.world.revision + 1, next.revision);
      next.events = next.events.slice(-180);
      const temporary = join(this.directory, 'world.json.tmp');
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, join(this.directory, 'world.json'));
      this.world = next;
      for (const listener of this.listeners) listener(structuredClone(next));
      return structuredClone(next);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async flush(): Promise<void> { await this.queue; }
}
