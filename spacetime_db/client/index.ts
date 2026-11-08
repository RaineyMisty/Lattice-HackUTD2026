import { DbConnection, tables } from '../bindings/index.ts';

export { DbConnection, reducers, tables } from '../bindings/index.ts';
export * from '../bindings/types.ts';
export { behaviorKey, entityKey, entityKinds, relationKey, relationKinds } from '../src/contract.ts';

export const maincloudUri = 'https://maincloud.spacetimedb.com';
export interface WorldConnectionConfig {
  uri: string;
  database: string;
  token?: string;
}

export function worldConnection(config: WorldConnectionConfig) {
  const builder = DbConnection.builder().withUri(config.uri).withDatabaseName(config.database);
  return config.token ? builder.withToken(config.token) : builder;
}

export function worldQueries(worldId: string, simulationId?: string, listWorlds = false) {
  const selectedWorld = tables.myWorlds.where(row => row.id.eq(worldId));
  return [
    listWorlds ? tables.myWorlds : selectedWorld,
    tables.myMemberships.where(row => row.worldId.eq(worldId)),
    tables.worldEntities.where(row => row.worldId.eq(worldId)),
    tables.worldRelations.where(row => row.worldId.eq(worldId)),
    tables.worldBehaviors.where(row => row.worldId.eq(worldId)),
    tables.worldEvidence.where(row => row.worldId.eq(worldId)),
    tables.worldFrontier.where(row => row.worldId.eq(worldId)),
    tables.worldSimulations.where(row => row.worldId.eq(worldId)),
    tables.worldStates.where(row => row.worldId.eq(worldId)),
    ...(simulationId ? [tables.worldSignal.where(row => row.simulationId.eq(simulationId))] : []),
  ];
}
