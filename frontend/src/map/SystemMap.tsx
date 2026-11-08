import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { boundsOf, createForceLayout, dependencyPath } from './layout';
import type { Placement, Point } from './layout';
import type { MapGraph, MapPresentation } from './types';
import './map.css';

const zero = { x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

interface Camera { center: Point; scale: number }
interface Gesture {
  pointerId: number;
  start: Point;
  camera: Camera;
  size: Point;
  freePan: boolean;
  pan: Point;
  node?: { id: string; offset: Point };
  moved: boolean;
}
interface MapProps {
  graph: MapGraph;
  presentation?: MapPresentation;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  placingBug?: boolean;
}

export default function SystemMap({ graph, presentation, selectedNodeId, onSelectNode, placingBug }: MapProps) {
  const { nodes, links } = graph;
  const svgId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const engine = useRef<ReturnType<typeof createForceLayout> | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [size, setSize] = useState({ x: 1, y: 1 });
  const [view, setView] = useState<Camera | null>(null);
  const [held, setHeld] = useState<Camera | null>(null);
  const [pan, setPan] = useState(zero);
  const [dragging, setDragging] = useState(false);

  const byId = new Map(placements.map(item => [item.id, item]));
  const detailIds = new Set(nodes.filter(node => node.detail).map(node => node.id));
  const hasOverview = placements.some(item => !detailIds.has(item.id));
  const overview = boundsOf(placements.filter(item => !hasOverview || !detailIds.has(item.id)));
  const fit = Math.min(1.3,
    Math.max(1, size.x - 32) / (overview.right - overview.left),
    Math.max(1, size.y - 38) / (overview.bottom - overview.top));
  const scale = Math.max(fit, view?.scale ?? fit);
  const showDetails = !hasOverview || scale / fit >= 1.65;
  const visible = showDetails ? placements : placements.filter(item => !detailIds.has(item.id));
  const visibleIds = new Set(visible.map(item => item.id));
  const scene = boundsOf(visible);
  const center = { x: (scene.left + scene.right) / 2, y: (scene.top + scene.bottom) / 2 };
  const freePan = (scene.right - scene.left) * scale >= size.x - 12 || (scene.bottom - scene.top) * scale >= size.y - 12;
  const camera = held ?? { scale, center: freePan ? view?.center ?? center : center };
  const wheelState = useRef({ camera, fit, size });
  wheelState.current = { camera, fit, size };

  useLayoutEffect(() => {
    const simulation = createForceLayout(setPlacements, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    engine.current = simulation;
    return () => { simulation.stop(); engine.current = null; };
  }, []);

  useLayoutEffect(() => {
    engine.current?.setGraph(nodes, links);
  }, [nodes, links]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ x: width, y: height });
    });
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !event.deltaY || gesture.current) return;
      event.preventDefault();
      const { camera, fit, size } = wheelState.current;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.y : 1;
      const next = clamp(camera.scale * Math.exp(clamp(-event.deltaY * units * .0024, -.5, .5)), fit, Math.max(3, fit * 6));
      if (next <= fit * 1.01) { setView(null); return; }
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - size.x / 2;
      const y = event.clientY - rect.top - size.y / 2;
      setView({ scale: next, center: {
        x: camera.center.x + x / camera.scale - x / next,
        y: camera.center.y + y / camera.scale - y / next,
      } });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, []);

  function begin(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const element = event.target instanceof Element ? event.target.closest('[data-map-node]') : null;
    const point = !placingBug && element ? byId.get(element.getAttribute('data-map-node') ?? '') : undefined;
    const node = point && { id: point.id, offset: {
      x: point.x - camera.center.x - (start.x - size.x / 2) / camera.scale,
      y: point.y - camera.center.y - (start.y - size.y / 2) / camera.scale,
    } };
    suppressClick.current = false;
    gesture.current = { pointerId: event.pointerId, start, camera, size, freePan, node, moved: false, pan: zero };
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const delta = { x: point.x - active.start.x, y: point.y - active.start.y };
    if (!active.moved && Math.hypot(delta.x, delta.y) < 5) return;
    if (!active.moved) {
      active.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setHeld(active.camera);
      setDragging(true);
    }
    if (active.node) {
      engine.current?.drag(active.node.id, {
        x: active.camera.center.x + (point.x - active.size.x / 2) / active.camera.scale + active.node.offset.x,
        y: active.camera.center.y + (point.y - active.size.y / 2) / active.camera.scale + active.node.offset.y,
      });
    } else {
      active.pan = active.freePan ? delta : { x: delta.x * .68, y: delta.y * .68 };
      setPan(active.pan);
    }
  }

  function finish(event: PointerEvent<SVGSVGElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!active.moved) return;
    if (active.node) engine.current?.release();
    else if (active.freePan) {
      setView({ scale: active.camera.scale, center: {
        x: active.camera.center.x - active.pan.x / active.camera.scale,
        y: active.camera.center.y - active.pan.y / active.camera.scale,
      } });
    }
    setHeld(null);
    setDragging(false);
    setPan(zero);
  }

  const selected = nodes.find(node => node.id === selectedNodeId && visibleIds.has(node.id));
  const selectedPoint = selected && byId.get(selected.id);
  const info = selectedPoint && {
    x: size.x / 2 + (selectedPoint.x - camera.center.x) * camera.scale + pan.x,
    y: size.y / 2 + (selectedPoint.y - camera.center.y) * camera.scale + pan.y,
  };
  const showInfo = info && info.x >= 0 && info.y >= 0 && info.x <= size.x && info.y <= size.y;

  return (
    <div className={`map${dragging ? ' is-dragging' : ''}`} ref={viewport} data-scale={camera.scale.toFixed(4)}
      data-pan-mode={(gesture.current?.moved ? gesture.current.freePan : freePan) ? 'free' : 'centered'}
      onKeyDown={event => { if (event.key === 'Escape') onSelectNode?.(null); }}>
      <svg viewBox={`0 0 ${size.x} ${size.y}`} role="group" aria-label="Service dependency map" onPointerDown={begin}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onPointerLeave={event => { if (!gesture.current?.moved) finish(event); }}
        onClick={event => { if (!suppressClick.current && !(event.target instanceof Element && event.target.closest('[data-map-node]'))) onSelectNode?.(null); }}>
        <defs>
          <radialGradient id={`${svgId}-light`} cx=".32" cy=".21" r=".9">
            <stop stopColor="#fff" stopOpacity=".52" />
            <stop offset=".45" stopColor="#fff" stopOpacity=".12" />
            <stop offset="1" stopColor="#17162d" stopOpacity=".25" />
          </radialGradient>
          <marker id={`${svgId}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L10 5L0 10Z" fill="context-stroke" />
          </marker>
        </defs>
        <g className="map-pan" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          <g className="map-camera" style={{ transform: `translate(${size.x / 2}px, ${size.y / 2}px) scale(${camera.scale}) translate(${-camera.center.x}px, ${-camera.center.y}px)` }}>
            {links.map(link => {
              const from = byId.get(link.from);
              const to = byId.get(link.to);
              if (!from || !to || from === to || !visibleIds.has(link.from) || !visibleIds.has(link.to)) return null;
              const style = presentation?.links?.[link.id];
              const dimmed = selectedNodeId && !style?.emphasized;
              return <path key={link.id} data-map-link={link.id}
                className={`map-edge tone-${style?.tone ?? 'neutral'}${style?.emphasized ? ' highlighted' : ''}${dimmed ? ' dimmed' : ''}`}
                style={style?.delayMs === undefined ? undefined : { animationDelay: `${style.delayMs}ms` }}
                d={dependencyPath(from, to)} markerEnd={`url(#${svgId}-arrow)`} />;
            })}
            {nodes.map(node => {
              const point = byId.get(node.id);
              if (!point || !visibleIds.has(node.id)) return null;
              const style = presentation?.nodes?.[node.id];
              const status = style?.caption;
              const isSelected = selectedNodeId === node.id;
              return (
                <g key={node.id} className={`map-node kind-${node.kind} tone-${style?.tone ?? 'neutral'}${style?.pulse ? ' pulsing' : ''}${isSelected ? ' selected' : ''}${style?.muted ? ' dimmed' : ''}`}
                  data-map-node={node.id} data-kind={node.kind} transform={`translate(${point.x} ${point.y})`}
                  style={{ '--impact-delay': `${style?.delayMs ?? 0}ms` } as CSSProperties}
                  role={onSelectNode ? 'button' : 'img'} tabIndex={onSelectNode ? 0 : undefined}
                  aria-label={status ? `${node.label}, ${status}` : node.label} aria-pressed={onSelectNode ? isSelected : undefined}
                  onClick={() => { if (!suppressClick.current) onSelectNode?.(node.id); }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectNode?.(node.id); }
                  }}>
                  <title>{node.label}</title>
                  <circle className="map-halo" r={point.radius + 5} />
                  <circle className="map-bubble" r={point.radius} />
                  <circle className="map-shine" r={point.radius - 1} fill={`url(#${svgId}-light)`} />
                  {status === 'BUG' && <text className="map-node-status" textAnchor="middle" y="4">BUG</text>}
                  <text className="map-label" textAnchor="middle">
                    {point.labels.map((label, index) => <tspan key={index} x="0" y={point.radius + 13 + index * 13}>{label}</tspan>)}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      {selected && info && showInfo && <aside className="map-node-info" style={{
        left: clamp(info.x + 28, 4, Math.max(4, size.x - 228)), top: clamp(info.y + 10, 4, Math.max(4, size.y - 118)),
      }}>
        <strong>{selected.label}</strong>
        <span>{selected.kind} · {links.filter(link => link.to === selected.id).length} incoming · {links.filter(link => link.from === selected.id).length} outgoing</span>
        {selected.sourcePath && <code>{selected.sourcePath}</code>}
      </aside>}
    </div>
  );
}
