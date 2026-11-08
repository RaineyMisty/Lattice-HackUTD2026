import { useEffect, useState } from 'react';
import {
  tables, worldConnection, worldQueries, type DbConnection, type Entity, type EntityState, type Frontier,
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
export type AgentMessage = { id: string; message: string };
export interface WorldSnapshot {
  world: RepositoryWorld;
  canSimulate: boolean;
  entities: Entity[];
  relations: Relation[];
  states: EntityState[];
  simulations: Simulation[];
  messages: AgentMessage[][];
}

export function useWorldFeed() {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [connection, setConnection] = useState<DbConnection | null>(null);
  const [worlds, setWorlds] = useState<RepositoryWorld[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
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
        const messages: AgentMessage[][] = Array.from({ length: 4 }, () => []);
        const seen = new Set<string>();
        function addMessage(worker: string, id: string, message: string) {
          if (!workers.has(worker) && workers.size < messages.length) workers.set(worker, workers.size);
          const slot = workers.get(worker);
          if (slot !== undefined) messages[slot].push({ id, message });
        }

        const read = () => {
          if (disposed || !applied) return;
          const available = [...client.db.myWorlds.iter()].filter(row => !/^0+$/.test(row.commit))
            .sort((a, b) => a.repository.localeCompare(b.repository) || a.id.localeCompare(b.id));
          setWorlds(available);
          const world = available.find(row => row.id === worldId);
          if (!world) {
            setSnapshot(null);
            if (!worldId && available.length) {
              setError('');
              return;
            }
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
            for (const queue of messages) queue.length = 0;
            seen.clear();
          }
          const tasks = [...client.db.worldFrontier.iter()].filter(row => row.worldId === world.id);
          for (const task of tasks) {
            if (!task.claimant || task.status !== 'leased') continue;
            const old = previousTasks.get(task.id);
            if (old?.attempt === task.attempt && old.status === task.status) continue;
            const worker = task.claimant.toHexString();
            const file = task.path.split('/').at(-1) || task.path;
            addMessage(worker, `task:${task.id}:${task.attempt}`, `Exploring ${file}…`);
          }
          previousTasks = new Map(tasks.map(row => [row.id, row]));
          const entities = [...client.db.worldEntities.iter()];
          const relations = [...client.db.worldRelations.iter()];
          const names = new Map(entities.map(row => [row.id, row.symbol || row.path.split('/').at(-1) || row.path]));
          const rules = [...client.db.worldBehaviors.iter()];
          const descriptions = new Map([
            ...entities.map(row => [row.id, `Found ${row.kind} ${names.get(row.id)}`] as const),
            ...relations.map(row => [row.id, `${names.get(row.from) ?? 'Source'} ${row.kind.replaceAll('_', ' ')} → ${names.get(row.to) ?? 'target'}`] as const),
            ...rules.map(row => {
              const effects = [...row.rule.set.map(action => `${action.key} = ${action.value}`), ...row.rule.emit.map(action => action.event)];
              return [row.id, `Rule ${row.name} · ${row.rule.event} → ${effects.join(', ')}`] as const;
            }),
          ]);
          const evidence = [...client.db.worldEvidence.iter()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
          for (const row of evidence) {
            if (row.verdict !== 'supports') continue;
            const author = row.author.toHexString();
            const id = `discovery:${author}:${row.subjectId}`;
            const description = descriptions.get(row.subjectId);
            if (seen.has(id) || !description) continue;
            seen.add(id);
            if (!firstRead) addMessage(author, id, description);
          }
          const role = [...client.db.myMemberships.iter()].find(row => row.worldId === world.id)?.role;
          setSnapshot({
            world, canSimulate: role === 'owner' || role === 'operator' || role === 'agent',
            entities, relations,
            states: [...client.db.worldStates.iter()].filter(row => row.worldId === world.id),
            simulations: [...client.db.worldSimulations.iter()].filter(row => row.worldId === world.id),
            messages: messages.map(queue => [...queue]),
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
          client.db.worldRelations, client.db.worldBehaviors, client.db.worldEvidence,
          client.db.worldStates, client.db.worldSimulations, client.db.worldFrontier]) {
          table.onInsert(changed);
          table.onUpdate(changed);
          table.onDelete(changed);
        }
        const queries = worldId ? worldQueries(worldId, undefined, true) : [tables.myWorlds];
        client.subscriptionBuilder()
          .onApplied(() => { applied = true; read(); })
          .onError(() => fail('Repository subscription failed'))
          .subscribe(queries);
      })
      .onConnectError((_context, cause) => fail(cause.message))
      .onDisconnect(() => fail('Database disconnected'))
      .build();
    return () => {
      disposed = true;
      conn.disconnect();
    };
  }, []);

  return { snapshot, connection, error, worlds, worldId };
}
