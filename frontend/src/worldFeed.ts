import { useEffect, useState } from 'react';
import {
  worldConnection, worldQueries, type DbConnection, type Entity, type EntityState, type Frontier,
  type Relation, type RepositoryWorld, type Simulation,
} from '../../spacetime_db/client';
import deployment from '../../spacetime_db/connection.json';

const uri = import.meta.env.VITE_LATTICE_DB_URL || deployment.maincloud.uri;
const database = import.meta.env.VITE_LATTICE_DATABASE || deployment.maincloud.database;
const worldId = new URLSearchParams(location.search).get('world') || import.meta.env.VITE_LATTICE_WORLD_ID;
const storageKey = `lattice.world:${uri}:${database}`;
const tokenKey = `${storageKey}:token`;
const fragment = new URLSearchParams(location.hash.slice(1));
const suppliedToken = fragment.get('operator');
if (suppliedToken) {
  sessionStorage.setItem(tokenKey, suppliedToken);
  history.replaceState(null, '', location.pathname + location.search);
}

export const simulationStorageKey = (id: string) => `${storageKey}:${id}:simulation`;
export type AgentMessage = { message: string; at: number };
export interface WorldSnapshot {
  world: RepositoryWorld;
  canSimulate: boolean;
  entities: Entity[];
  relations: Relation[];
  states: EntityState[];
  simulations: Simulation[];
  messages: AgentMessage[];
}

export function useWorldFeed() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [connection, setConnection] = useState<DbConnection | null>(null);
  const [error, setError] = useState(worldId ? '' : 'Select a repository world');

  useEffect(() => {
    if (!worldId) return;
    let disposed = false;
    const fail = (message: string) => {
      if (disposed) return;
      setConnection(null);
      setError(message);
    };
    const conn = worldConnection({ uri, database, token: sessionStorage.getItem(tokenKey) ?? undefined })
      .onConnect((client, identity, token) => {
        if (disposed) return;
        sessionStorage.setItem(tokenKey, token);
        let applied = false;
        let pending = false;
        let currentWorldId = '';
        let previousTasks = new Map<string, Frontier>();
        const workers = new Map<string, number>();
        const messages: AgentMessage[] = [];

        const read = () => {
          if (disposed || !applied) return;
          const world = [...client.db.myWorlds.iter()].find(row => row.id === worldId && !/^0+$/.test(row.commit));
          if (!world) {
            setSnapshot(null);
            if (currentWorldId !== 'no-access') console.info('Lattice browser identity', identity.toHexString());
            currentWorldId = 'no-access';
            setError('Repository access required');
            return;
          }
          const firstRead = currentWorldId !== world.id;
          if (firstRead) {
            currentWorldId = world.id;
            previousTasks.clear();
            workers.clear();
            messages.length = 0;
          }
          const tasks = [...client.db.worldFrontier.iter()].filter(row => row.worldId === world.id);
          for (const task of tasks) {
            if (!task.claimant || (task.status !== 'leased' && task.status !== 'done')) continue;
            const old = previousTasks.get(task.id);
            if (old?.attempt === task.attempt && old.status === task.status) continue;
            if (firstRead && task.status === 'done') continue;
            const worker = task.claimant.toHexString();
            if (!workers.has(worker) && workers.size < 4) workers.set(worker, workers.size);
            const slot = workers.get(worker);
            if (slot !== undefined) {
              const file = task.path.split('/').at(-1) || task.path;
              messages[slot] = { message: task.status === 'leased' ? `Exploring ${file}…` : `Finished ${file}`, at: Date.now() };
            }
          }
          previousTasks = new Map(tasks.map(row => [row.id, row]));
          const role = [...client.db.myMemberships.iter()].find(row => row.worldId === world.id)?.role;
          setSnapshot({
            world, canSimulate: role === 'owner' || role === 'operator' || role === 'agent',
            entities: [...client.db.worldEntities.iter()].filter(row => row.worldId === world.id),
            relations: [...client.db.worldRelations.iter()].filter(row => row.worldId === world.id),
            states: [...client.db.worldStates.iter()].filter(row => row.worldId === world.id),
            simulations: [...client.db.worldSimulations.iter()].filter(row => row.worldId === world.id),
            messages: [...messages],
          });
          setConnection(client);
          setError('');
        };
        const changed = () => {
          if (pending || !applied) return;
          pending = true;
          queueMicrotask(() => { pending = false; read(); });
        };
        for (const table of [client.db.myWorlds, client.db.myMemberships, client.db.worldEntities,
          client.db.worldRelations, client.db.worldStates, client.db.worldSimulations, client.db.worldFrontier]) {
          table.onInsert(changed);
          table.onUpdate(changed);
          table.onDelete(changed);
        }
        client.subscriptionBuilder()
          .onApplied(() => { applied = true; read(); })
          .onError(() => fail('Repository subscription failed'))
          .subscribe(worldQueries(worldId));
      })
      .onConnectError((_context, cause) => fail(cause.message))
      .onDisconnect(() => fail('Database disconnected'))
      .build();
    return () => {
      disposed = true;
      conn.disconnect();
    };
  }, []);

  return { snapshot, connection, error };
}
