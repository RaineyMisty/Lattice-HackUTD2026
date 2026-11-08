import type { WorldClient } from '../../../../packages/contracts/src/index';

/**
 * Integration boundary. Generate SDK bindings from /spacetimedb, then register a
 * factory here before App mounts. Its subscribe implementation must materialize
 * database rows and subscribe to reducers' results; it must never derive risk in UI.
 * A deliberately missing connector fails explicitly rather than showing demo data.
 */
let connector: (() => WorldClient) | undefined;
export function registerSpacetimeConnector(factory: () => WorldClient) { connector = factory; }
export function createSpacetimeClient(): WorldClient {
  if (!connector) throw new Error('SpacetimeDB connector is not configured. Generate the SDK bindings and register a WorldClient in src/data/spacetimedb.ts. Use VITE_DATA_MODE=local for the local demo.');
  return connector();
}
