import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import type { MapLink, MapNode } from './types';

export interface Point { x: number; y: number }
export interface Bounds { left: number; right: number; top: number; bottom: number }
export interface Placement extends Point {
  id: string;
  radius: number;
  collision: number;
  labels: string[];
}
interface Particle extends Placement, SimulationNodeDatum {
  x: number;
  y: number;
  group: string;
  anchor: Point;
}
interface Spring extends SimulationLinkDatum<Particle> {
  source: Particle;
  target: Particle;
}

const goldenAngle = Math.PI * (3 - Math.sqrt(5));

function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

function wrap(label: string) {
  const labels: string[] = [];
  let rest = label;
  while (rest.length > 18 && labels.length < 3) {
    const split = Math.max(rest.lastIndexOf('-', 17), rest.lastIndexOf(' ', 17)) + 1;
    const end = split >= 6 ? split : 18;
    labels.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) labels.push(rest.length > 18 ? `${rest.slice(0, 17)}…` : rest);
  return labels;
}

function groups(nodes: readonly MapNode[], links: readonly MapLink[]) {
  const regions = new Map(nodes.map(node => [node.id, node.region]));
  const parent = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const region of regions.values()) sizes.set(region, (sizes.get(region) ?? 0) + 1);
  const root = (region: string) => {
    while (parent.has(region)) region = parent.get(region)!;
    return region;
  };
  const pairs = new Map<string, { a: string; b: string; weight: number }>();
  for (const link of links) {
    const from = regions.get(link.from);
    const to = regions.get(link.to);
    if (from === undefined || to === undefined || from === to) continue;
    const [a, b] = from < to ? [from, to] : [to, from];
    const id = JSON.stringify([a, b]);
    const pair = pairs.get(id);
    if (pair) pair.weight++;
    else pairs.set(id, { a, b, weight: 1 });
  }
  for (const pair of [...pairs.values()].sort((a, b) => b.weight - a.weight || a.a.localeCompare(b.a) || a.b.localeCompare(b.b))) {
    const a = root(pair.a);
    const b = root(pair.b);
    const size = sizes.get(a)! + sizes.get(b)!;
    if (a === b || size > 9) continue;
    const [keep, merge] = a < b ? [a, b] : [b, a];
    parent.set(merge, keep);
    sizes.set(keep, size);
  }
  const groupOf = new Map(nodes.map(node => [node.id, root(node.region)]));
  const ordered = [...new Set(groupOf.values())].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a.localeCompare(b));
  const anchors = new Map(ordered.map((group, index) => {
    const distance = 105 * Math.sqrt(index);
    return [group, { x: Math.cos(index * goldenAngle) * distance * 1.3, y: Math.sin(index * goldenAngle) * distance * .74 }];
  }));
  return { groupOf, anchors };
}

export function boundsOf(nodes: readonly Placement[]): Bounds {
  if (!nodes.length) return { left: -40, right: 40, top: -40, bottom: 40 };
  return {
    left: Math.min(...nodes.map(node => node.x - node.collision)),
    right: Math.max(...nodes.map(node => node.x + node.collision)),
    top: Math.min(...nodes.map(node => node.y - node.radius - 6)),
    bottom: Math.max(...nodes.map(node => node.y + node.radius + 11 + node.labels.length * 13)),
  };
}

export function dependencyPath(from: Placement, to: Placement) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return '';
  const x = dx / length;
  const y = dy / length;
  const start = { x: from.x + x * from.radius, y: from.y + y * from.radius };
  const end = { x: to.x - x * (to.radius + 4), y: to.y - y * (to.radius + 4) };
  const bend = Math.min(16, length * .06);
  return `M${start.x},${start.y}Q${(start.x + end.x) / 2 - y * bend},${(start.y + end.y) / 2 + x * bend} ${end.x},${end.y}`;
}

export function createForceLayout(render: (nodes: Placement[]) => void, reducedMotion: boolean) {
  let particles = new Map<string, Particle>();
  let signature: string | undefined;
  let grab: { id: string; point: Point } | undefined;
  const spring = forceLink<Particle, Spring>()
    .distance(({ source, target }) => source.radius + target.radius + (source.group === target.group ? 52 : 92))
    .strength(({ source, target }) => source.group === target.group ? .20 : .075);
  const publish = () => render([...particles.values()].map(({ id, x, y, radius, collision, labels }) =>
    ({ id, x, y, radius, collision, labels })));
  const simulation = forceSimulation<Particle>().stop()
    .alphaMin(.009).alphaDecay(.065).velocityDecay(.43)
    .force('links', spring)
    .force('charge', forceManyBody<Particle>().strength(-160).distanceMax(420))
    .force('collide', forceCollide<Particle>(node => node.collision).iterations(3))
    .force('center', forceCenter<Particle>(0, 0).strength(.04))
    .force('x', forceX<Particle>(node => node.anchor.x).strength(.037))
    .force('y', forceY<Particle>(node => node.anchor.y).strength(.057))
    .on('tick', publish);

  function heat(alpha: number) {
    simulation.alpha(Math.max(simulation.alpha(), alpha));
    if (reducedMotion) simulation.stop().tick(75);
    else simulation.restart();
    publish();
  }

  return {
    setGraph(nodes: readonly MapNode[], links: readonly MapLink[]) {
      const key = JSON.stringify([
        nodes.map(node => [node.id, node.label, node.region, node.kind, node.major]).sort(),
        links.map(link => [link.from, link.to]).sort(),
      ]);
      if (key === signature) return;
      signature = key;
      const { groupOf, anchors } = groups(nodes, links);
      const neighbors = new Map<string, Particle[]>();
      function remember(id: string, other: string) {
        const particle = particles.get(other);
        if (particle) neighbors.set(id, [...(neighbors.get(id) ?? []), particle]);
      }
      for (const link of links) {
        remember(link.from, link.to);
        remember(link.to, link.from);
      }
      const hadParticles = particles.size > 0;
      particles = new Map(nodes.map(node => {
        const group = groupOf.get(node.id)!;
        const anchor = anchors.get(group)!;
        const previous = particles.get(node.id);
        const nearby = neighbors.get(node.id);
        const angle = hash(node.id) / 0x100000000 * 2 * Math.PI;
        const base = nearby?.length ? {
          x: nearby.reduce((sum, item) => sum + item.x, 0) / nearby.length,
          y: nearby.reduce((sum, item) => sum + item.y, 0) / nearby.length,
        } : anchor;
        const radius = node.major ? 27 : node.kind === 'service' ? 23 : 16;
        const labels = wrap(node.label);
        const labelWidth = Math.max(0, ...labels.map(label => label.length * 3.4));
        const collision = Math.max(radius + 10, labelWidth + 7, radius + 7 + labels.length * 12);
        return [node.id, {
          ...previous, id: node.id, radius, labels, collision, group, anchor,
          x: previous?.x ?? base.x + Math.cos(angle) * 48, y: previous?.y ?? base.y + Math.sin(angle) * 48,
        }];
      }));
      if (grab && !particles.has(grab.id)) {
        grab = undefined;
        simulation.alphaTarget(0);
      }
      const springs: Spring[] = [];
      for (const link of links) {
        const source = particles.get(link.from);
        const target = particles.get(link.to);
        if (source && target && source !== target) springs.push({ source, target });
      }
      spring.links([]);
      simulation.nodes([...particles.values()]);
      spring.links(springs);
      if (particles.size) heat(hadParticles ? .34 : .85);
      else { simulation.stop(); publish(); }
    },
    drag(id: string, point: Point) {
      const node = particles.get(id);
      if (!node) return;
      if (!grab) {
        grab = { id, point: { x: node.x, y: node.y } };
        if (!reducedMotion) simulation.alphaTarget(.13).alpha(Math.max(.24, simulation.alpha())).restart();
      }
      node.x = node.fx = point.x;
      node.y = node.fy = point.y;
      publish();
    },
    release() {
      if (!grab) return;
      const node = particles.get(grab.id);
      if (node) {
        node.fx = node.fy = null;
        node.vx = Math.max(-7, Math.min(7, (grab.point.x - node.x) * .08));
        node.vy = Math.max(-7, Math.min(7, (grab.point.y - node.y) * .08));
      }
      grab = undefined;
      simulation.alphaTarget(0);
      heat(.27);
    },
    stop() { simulation.stop(); },
  };
}
