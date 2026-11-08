import type { LinkAppearance, MapGraph, MapPresentation, NodeAppearance } from './map/types';

export function withSelection(graph: MapGraph, presentation: MapPresentation, selected: string | null): MapPresentation {
  if (!selected) return presentation;
  const related = new Set([selected]);
  const links: Record<string, LinkAppearance> = { ...presentation.links };
  const nodes: Record<string, NodeAppearance> = { ...presentation.nodes };
  for (const link of graph.links) {
    if (link.from !== selected && link.to !== selected) continue;
    related.add(link.from);
    related.add(link.to);
    links[link.id] = { ...links[link.id], emphasized: true };
  }
  for (const node of graph.nodes) {
    if (!related.has(node.id) && nodes[node.id]?.tone !== 'warning') nodes[node.id] = { ...nodes[node.id], muted: true };
  }
  return { ...presentation, nodes, links };
}
