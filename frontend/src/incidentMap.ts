import type { Entity, EntityState, Relation } from '../../spacetime_db/client';
import type { LinkAppearance, MapGraph, MapPresentation, NodeAppearance, NodeKind } from './map/types';

const kinds: Record<string, NodeKind> = {
  service: 'service', module: 'module', file: 'file', function: 'function', class: 'component', resource: 'data',
};

export function buildRepositoryGraph(entities: Entity[] = [], relations: Relation[] = []): MapGraph {
  const nodes = entities.filter(entity => entity.active).map(entity => ({
    id: entity.id,
    label: entity.symbol || entity.path.split('/').at(-1) || entity.path,
    region: entity.path.includes('/') ? entity.path.split('/')[0] : 'Repository',
    kind: kinds[entity.kind] ?? 'component',
    major: entity.kind === 'service',
  }));
  const ids = new Set(nodes.map(node => node.id));
  const links = relations.filter(edge => edge.active && ids.has(edge.from) && ids.has(edge.to))
    .map(edge => ({ id: edge.id, from: edge.from, to: edge.to }));
  const homeRegion = nodes.find(node => node.kind === 'service')?.region ?? nodes[0]?.region ?? 'Repository';
  return { nodes, links, homeRegion };
}

export function presentSimulation(entities: Entity[], states: EntityState[], simulationId: string | undefined) {
  const nodes: Record<string, NodeAppearance> = {};
  const links: Record<string, LinkAppearance> = {};
  const entityIds = new Map(entities.filter(entity => entity.active).map(entity => [entity.key, entity.id]));
  let focusNodeId: string | undefined;
  for (const row of states) {
    if (!simulationId || row.simulationId !== simulationId || !row.key.startsWith('lattice.impact:')) continue;
    const id = entityIds.get(row.entity);
    if (!id) continue;
    const impact = JSON.parse(row.value) as { status: string; relation?: string };
    if (impact.status === 'fault_origin') {
      nodes[id] = { tone: 'warning', caption: 'BUG', pulse: true };
      focusNodeId = id;
    } else if (impact.status === 'potential_impact') {
      nodes[id] ??= { tone: 'caution', caption: 'Potential impact' };
      if (impact.relation) links[impact.relation] = { tone: 'caution', emphasized: true };
    }
  }
  const presentation: MapPresentation = { nodes, links, focusNodeId };
  const origins = Object.values(nodes).filter(node => node.tone === 'warning').length;
  return { presentation, origins, potential: Object.keys(nodes).length - origins };
}
