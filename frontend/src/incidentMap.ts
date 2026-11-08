import type { Entity, EntityState, Relation } from '../../spacetime_db/client';
import type { LinkAppearance, MapGraph, MapPresentation, NodeAppearance, NodeKind } from './map/types';

const kinds: Record<string, NodeKind> = {
  service: 'service', module: 'module', file: 'file', function: 'function', class: 'class', resource: 'resource',
};

export function buildRepositoryGraph(entities: Entity[] = [], relations: Relation[] = []): MapGraph {
  const nodes = entities.filter(entity => entity.active).map(entity => ({
    id: entity.id,
    label: entity.symbol || entity.path.split('/').at(-1) || entity.path,
    region: entity.path.includes('/') ? entity.path.split('/')[0] : 'Repository',
    kind: kinds[entity.kind] ?? 'component',
    major: entity.kind === 'service',
    detail: ['function', 'class', 'file'].includes(entity.kind),
    sourcePath: entity.path,
  }));
  const ids = new Set(nodes.map(node => node.id));
  const links = relations.filter(edge => edge.active && ids.has(edge.from) && ids.has(edge.to))
    .map(edge => ({ id: edge.id, from: edge.from, to: edge.to }));
  return { nodes, links };
}

export function presentSimulation(entities: Entity[], states: EntityState[], simulationId: string | undefined) {
  const nodes: Record<string, NodeAppearance> = {};
  const links: Record<string, LinkAppearance> = {};
  const entityIds = new Map(entities.filter(entity => entity.active).map(entity => [entity.key, entity.id]));
  for (const row of states) {
    if (!simulationId || row.simulationId !== simulationId || !row.key.startsWith('lattice.impact:')) continue;
    const id = entityIds.get(row.entity);
    if (!id) continue;
    const impact = JSON.parse(row.value) as { status: string; level?: number; relation?: string };
    if (impact.status === 'fault_origin') {
      nodes[id] = { tone: 'warning', caption: 'BUG', pulse: true };
    } else if (impact.status === 'potential_impact') {
      const delayMs = Math.min(600, (impact.level ?? 1) * 100);
      nodes[id] ??= { tone: 'caution', caption: 'Potential impact', delayMs };
      if (impact.relation) links[impact.relation] = { tone: 'caution', emphasized: true, delayMs };
    }
  }
  const presentation: MapPresentation = { nodes, links };
  const origins = Object.values(nodes).filter(node => node.tone === 'warning').length;
  return { presentation, origins, potential: Object.keys(nodes).length - origins };
}
