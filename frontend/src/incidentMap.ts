import type { WorldSnapshot } from '../../shared/types';
import type { LinkAppearance, MapGraph, MapNode, MapPresentation, NodeAppearance } from './map/types';
import { demoLinks, demoNodes, incidentRegion as homeRegion, primaryNodes } from './incidentMapFixture';

export function buildIncidentGraph(world: WorldSnapshot | null): MapGraph {
  const assets = world?.assets ?? [];
  const knownAssets = new Map(assets.map(asset => [asset.id, asset]));
  const nodes: MapNode[] = primaryNodes.map(node => ({ ...node, label: knownAssets.get(node.id)?.name ?? node.label }));
  for (const asset of assets) {
    if (nodes.some(node => node.id === asset.id)) continue;
    nodes.push({
      id: asset.id, label: asset.name, region: asset.department || homeRegion,
      kind: 'service', major: asset.businessCriticality === 'critical',
    });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const links = [];
  for (const edge of world?.dependencies ?? []) {
    const source = byId.get(edge.from);
    if (!source) continue;
    if (edge.kind === 'component' && !byId.has(edge.to)) {
      const node: MapNode = {
        id: edge.to, label: edge.to === 'tokengate' ? 'TokenGate' : edge.to,
        region: source.region, kind: 'component', major: true,
      };
      nodes.push(node);
      byId.set(node.id, node);
    }
    if (byId.has(edge.to)) links.push({ id: JSON.stringify([edge.from, edge.to, edge.kind]), from: edge.from, to: edge.to });
  }
  if (assets.length > 4) return { nodes, links, homeRegion };
  return { nodes: [...nodes, ...demoNodes], links: [...links, ...demoLinks], homeRegion };
}

export function incidentPresentation(world: WorldSnapshot | null, graph: MapGraph, bugNodeId: string | null = null): MapPresentation {
  const nodes: Record<string, NodeAppearance> = {};
  const links: Record<string, LinkAppearance> = {};
  let healthFocus: string | undefined;
  let impactFocus: string | undefined;
  for (const asset of world?.assets ?? []) {
    if (asset.health) {
      healthFocus ??= asset.id;
      nodes[asset.id] = { tone: 'warning', caption: asset.health === 'attack' ? 'UNDER ATTACK' : 'SERVICE ERROR', pulse: true };
    } else if (asset.status === 'direct') {
      impactFocus ??= asset.id;
      nodes[asset.id] = { tone: 'warning', caption: 'DIRECT IMPACT', pulse: true };
    } else if (asset.status === 'downstream') {
      nodes[asset.id] = { tone: 'caution', caption: 'Downstream risk' };
    } else if (asset.status === 'unaffected') {
      nodes[asset.id] = { tone: 'positive', caption: 'Unaffected' };
    }
  }
  for (const link of graph.links) {
    const tone = nodes[link.from]?.tone;
    if (tone) links[link.id] = { tone };
  }
  if (bugNodeId && graph.nodes.some(node => node.id === bugNodeId && node.kind === 'service')) {
    nodes[bugNodeId] = { tone: 'warning', caption: 'BUG', pulse: true };
  }
  return { nodes, links, focusNodeId: healthFocus ?? impactFocus };
}
