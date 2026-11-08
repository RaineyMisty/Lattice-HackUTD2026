import { t } from 'spacetimedb/server';
import { behavior, db, entity, evidence, frontier, member, relation, simulation, state, world } from './schema';

export default db;
export { claimTask, createWorld, expireLease, init, reviewDiscovery, setDiscoveryActive, setMember, submitDiscovery } from './knowledge';
export { advanceEvent, clearBug, createSimulation, requestEvent, setBug, stopSimulation } from './simulation';

export const myWorlds = db.view({ name: 'my_worlds', public: true }, t.array(world.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].map(row => ctx.db.world.id.find(row.worldId)!));

export const myMemberships = db.view({ name: 'my_memberships', public: true }, t.array(member.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)]);

export const worldEntities = db.view({ name: 'world_entities', public: true }, t.array(entity.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.entity.worldId.filter(row.worldId)]));

export const worldRelations = db.view({ name: 'world_relations', public: true }, t.array(relation.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.relation.worldId.filter(row.worldId)]));

export const worldBehaviors = db.view({ name: 'world_behaviors', public: true }, t.array(behavior.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.behavior.worldId.filter(row.worldId)]));

export const worldEvidence = db.view({ name: 'world_evidence', public: true }, t.array(evidence.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.evidence.worldId.filter(row.worldId)]));

export const worldFrontier = db.view({ name: 'world_frontier', public: true }, t.array(frontier.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.frontier.worldId.filter(row.worldId)]));

export const worldSimulations = db.view({ name: 'world_simulations', public: true }, t.array(simulation.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.simulation.worldId.filter(row.worldId)]));

export const worldStates = db.view({ name: 'world_states', public: true }, t.array(state.rowType), ctx =>
  [...ctx.db.member.identity.filter(ctx.sender)].flatMap(row => [...ctx.db.state.worldId.filter(row.worldId)]));
