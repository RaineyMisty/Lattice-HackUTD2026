import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { boundsOf, dependencyPath, layoutTopology } from './layout';
import type { Bounds } from './layout';
import type { MapLink, MapNode, NodeAlert } from './topology';
import './map.css';

const alerts: Record<NodeAlert, string> = { attack: 'UNDER ATTACK', error: 'SERVICE ERROR', impact: 'DIRECT IMPACT' };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const center = (box: Bounds) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

interface MapProps {
  nodes: MapNode[];
  links: MapLink[];
  homeRegion: string;
}

export default function SystemMap({ nodes, links, homeRegion }: MapProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(0);
  const [dragging, setDragging] = useState(false);
  const layout = useMemo(() => layoutTopology(nodes, links, homeRegion), [nodes, links, homeRegion]);
  const byId = new Map(layout.placements.map(item => [item.node.id, item]));
  const selection = selected ? byId.get(selected) : undefined;
  const warning = layout.placements.find(item => item.node.alert === 'attack' || item.node.alert === 'error')
    ?? layout.placements.find(item => item.node.alert);
  const focusRegion = selection?.node.region ?? warning?.node.region ?? homeRegion;
  const related = new Set(selection ? [selection.node.id] : []);
  if (selection) {
    for (const link of links) {
      if (link.from === selection.node.id) related.add(link.to);
      if (link.to === selection.node.id) related.add(link.from);
    }
  }
  const close = layout.placements.filter(item => item.node.region === focusRegion && (!selection || related.has(item.node.id)));
  const focusBox = boundsOf(close);
  const fit = (box: Bounds, padding: number) => Math.min(
    size.width / (box.right - box.left + padding),
    size.height / (box.bottom - box.top + padding),
  );
  const baseScale = Math.min(1.5, fit(focusBox, 76));
  const overviewScale = Math.min(baseScale, fit(layout.bounds, 104));
  const scale = clamp(baseScale * zoom, overviewScale, Math.max(baseScale, 2.2));
  const blend = baseScale === overviewScale ? 1 : clamp((scale - overviewScale) / (baseScale - overviewScale), 0, 1);
  const focus = center(focusBox);
  const overview = center(layout.bounds);
  const x = overview.x + (focus.x - overview.x) * blend;
  const y = overview.y + (focus.y - overview.y) * blend;
  const isOverview = blend < .56;

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      const change = Math.exp(clamp(-event.deltaY * units * .0024, -.44, .44));
      setZoom(current => clamp(current * change, overviewScale / baseScale, Math.max(baseScale, 2.2) / baseScale));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [baseScale, overviewScale, size.height]);

  function select(id: string | null) {
    setSelected(id === selected ? null : id);
    setZoom(1);
  }

  function begin(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    gesture.current = { id: event.pointerId, x: event.clientX, moved: false };
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.id) return;
    const delta = event.clientX - active.x;
    if (!active.moved && Math.abs(delta) < 5) return;
    if (!active.moved) {
      active.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    setPan(clamp(delta, -size.width * 2, size.width * 2));
  }

  function finish(event: PointerEvent<SVGSVGElement>) {
    if (gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    setPan(0);
  }

  return (
    <div className={`map ${dragging ? 'is-dragging' : ''}`} ref={viewport} data-scale={scale.toFixed(4)} onKeyDown={event => {
      if (event.key === 'Escape') select(null);
    }}>
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label="Service dependency map" onPointerDown={begin}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onPointerLeave={event => { if (!gesture.current?.moved) finish(event); }}>
        <defs>
          <marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto">
            <path d="M0 0L10 5L0 10Z" fill="context-stroke" />
          </marker>
        </defs>
        <g className="map-pan" style={{ transform: `translateX(${pan}px)` }}>
          <g className="map-camera" style={{ transform: `translate(${size.width / 2}px, ${size.height / 2}px) scale(${scale}) translate(${-x}px, ${-y}px)` }}>
            {layout.regions.filter(region => region.name !== homeRegion).map(({ name, bounds }) => (
              <g className="map-region" key={name} aria-hidden="true">
                <rect x={bounds.left - 14} y={bounds.top - 40} width={bounds.right - bounds.left + 28} height={bounds.bottom - bounds.top + 54} rx="16" />
                <text x={bounds.left} y={bounds.top - 15}>{name}</text>
              </g>
            ))}
            {links.map(link => {
              const from = byId.get(link.from);
              const to = byId.get(link.to);
              if (!from || !to || from === to) return null;
              const crossRegion = from.node.region !== to.node.region;
              const highlighted = selection && (link.from === selection.node.id || link.to === selection.node.id);
              if (crossRegion && !isOverview && !highlighted) return null;
              const variant = from.node.alert ? 'warn' : from.node.risk === 'downstream' ? 'downstream' : from.node.risk === 'unaffected' ? 'unaffected' : '';
              return <path key={`${link.from}:${link.to}`} className={`map-edge ${variant} ${crossRegion ? 'cross-region' : ''} ${highlighted ? 'highlighted' : ''}`}
                d={dependencyPath(from, to)} markerEnd="url(#map-arrow)" />;
            })}
            {layout.placements.map(({ node, x: nodeX, y: nodeY, width, height }) => {
              const status = node.alert ? alerts[node.alert]
                : node.risk === 'downstream' ? 'Downstream risk' : node.risk === 'unaffected' ? 'Unaffected' : '';
              const accessibleName = status ? `${node.label}, ${status}` : node.label;
              return (
                <g key={node.id} className={`map-node kind-${node.kind} ${node.major ? 'major' : ''} ${node.alert ? 'warn' : ''} ${selected === node.id ? 'selected' : ''} ${selection && !related.has(node.id) ? 'dimmed' : ''}`}
                  data-map-node={node.id} data-kind={node.kind} transform={`translate(${nodeX} ${nodeY})`}
                  role="button" tabIndex={0} aria-label={accessibleName} aria-pressed={selected === node.id}
                  onClick={() => { if (!suppressClick.current) select(node.id); }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      select(node.id);
                    }
                  }}>
                  <rect key={node.alert ?? 'normal'} className="map-tile" x={-width / 2} y={-height / 2} width={width} height={height} rx={node.major ? 12 : 8} />
                  <text className="map-label" textAnchor="middle" y={status ? -3 : 5}>{node.label}</text>
                  {status && <text className="map-node-status" textAnchor="middle" y={15}>{status}</text>}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}
