import type { MapLink, MapNode } from './types';

export interface Bounds { left: number; right: number; top: number; bottom: number }
export interface Placement { node: MapNode; x: number; y: number; width: number; height: number }
interface Region { name: string; bounds: Bounds }

const rowGap = 104;
const columnGap = 26;
const isPrimary = (node: MapNode) => !['data', 'queue', 'gateway', 'config', 'container'].includes(node.kind);

export function boundsOf(placements: Placement[]): Bounds {
  if (!placements.length) return { left: -100, right: 100, top: -60, bottom: 60 };
  return {
    left: Math.min(...placements.map(item => item.x - item.width / 2)),
    right: Math.max(...placements.map(item => item.x + item.width / 2)),
    top: Math.min(...placements.map(item => item.y - item.height / 2)),
    bottom: Math.max(...placements.map(item => item.y + item.height / 2)),
  };
}

function arrangeRegion(nodes: MapNode[], links: readonly MapLink[]) {
  const services = nodes.filter(isPrimary);
  const serviceIds = new Set(services.map(node => node.id));
  const hasComponent = services.some(node => node.kind === 'component');
  const rank = new Map(services.map(node => [node.id, hasComponent && node.kind !== 'component' ? 1 : 0]));
  const localLinks = links.filter(link => serviceIds.has(link.from) && serviceIds.has(link.to));
  const remaining = new Map(services.map(node => [node.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const { from, to } of localLinks) {
    remaining.set(from, remaining.get(from)! + 1);
    const children = dependents.get(to) ?? [];
    children.push(from);
    dependents.set(to, children);
  }
  const roots = services.filter(node => remaining.get(node.id) === 0).map(node => node.id);
  for (const id of roots) {
    for (const child of dependents.get(id) ?? []) {
      rank.set(child, Math.max(rank.get(child)!, rank.get(id)! + 1));
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) roots.push(child);
    }
  }

  const rows = new Map<number, MapNode[]>();
  const lastServiceRank = Math.max(0, ...rank.values());
  for (const node of nodes) {
    const layer = isPrimary(node) ? rank.get(node.id)! : lastServiceRank + 1;
    const row = rows.get(layer) ?? [];
    row.push(node);
    rows.set(layer, row);
  }
  const placements: Placement[] = [];
  let rowNumber = 0;
  for (const [, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    for (let offset = 0; offset < row.length; offset += 5) {
      const line = row.slice(offset, offset + 5);
      const widths = line.map(node => node.major ? 200 : 162);
      const span = widths.reduce((sum, width) => sum + width, 0) + columnGap * (line.length - 1);
      let left = -span / 2;
      line.forEach((node, index) => {
        const width = widths[index];
        placements.push({ node, x: left + width / 2, y: rowNumber * rowGap, width, height: node.major ? 64 : 50 });
        left += width + columnGap;
      });
      rowNumber++;
    }
  }
  const box = boundsOf(placements);
  const middle = (box.top + box.bottom) / 2;
  return placements.map(item => ({ ...item, y: item.y - middle }));
}

export function layoutTopology(nodes: readonly MapNode[], links: readonly MapLink[], homeRegion: string) {
  const groups = new Map<string, MapNode[]>();
  for (const node of nodes) {
    const group = groups.get(node.region) ?? [];
    group.push(node);
    groups.set(node.region, group);
  }
  const clusters = [...groups].map(([name, group]) => ({ name, nodes: arrangeRegion(group, links) }));
  const sizes = clusters.map(cluster => boundsOf(cluster.nodes));
  const stepX = Math.max(200, ...sizes.map(box => box.right - box.left)) + 115;
  const stepY = Math.max(120, ...sizes.map(box => box.bottom - box.top)) + 125;
  const slots = [[-1, 0], [1, 0], [-1, 1], [1, 1], [-1, -1], [1, -1], [0, -1]];
  const placements: Placement[] = [];
  const regions: Region[] = [];
  let outside = 0;
  for (const cluster of clusters) {
    const index = cluster.name === homeRegion ? -1 : outside++;
    const [column, row] = index < 0 ? [0, 0] : slots[index] ?? [(index % 3) - 1, 2 + Math.floor((index - slots.length) / 3)];
    const moved = cluster.nodes.map(item => ({ ...item, x: item.x + column * stepX, y: item.y + row * stepY }));
    placements.push(...moved);
    regions.push({ name: cluster.name, bounds: boundsOf(moved) });
  }
  return { placements, regions, bounds: boundsOf(placements) };
}

export function dependencyPath(from: Placement, to: Placement) {
  if (from.y === to.y) {
    const direction = Math.sign(to.x - from.x);
    return `M${from.x + direction * from.width / 2} ${from.y}H${to.x - direction * (to.width / 2 + 2)}`;
  }
  const direction = Math.sign(to.y - from.y);
  const startY = from.y + direction * from.height / 2;
  const endY = to.y - direction * (to.height / 2 + 2);
  const middle = (startY + endY) / 2;
  const endX = to.x + Math.sign(from.x - to.x) * Math.min(to.width * .19, 28);
  return `M${from.x} ${startY}C${from.x} ${middle} ${endX} ${middle} ${endX} ${endY}`;
}
