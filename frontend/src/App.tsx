import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Bug, Crosshair, GitBranch, Layers3, Play, RotateCcw, Users } from 'lucide-react';

import SystemMap from './map/SystemMap';
import { withSelection } from './mapSelection';
import { buildRepositoryGraph, presentSimulation } from './incidentMap';
import { simulationStorageKey, useWorldFeed, type AgentMessage } from './worldFeed';

const agents = [
  { id: 'A', icon: Crosshair, color: 'violet' },
  { id: 'B', icon: GitBranch, color: 'cyan' },
  { id: 'C', icon: Layers3, color: 'indigo' },
  { id: 'D', icon: Users, color: 'mint' },
] as const;

export default function App() {
  const { snapshot, connection, error: feedError } = useWorldFeed();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pickup, setPickup] = useState<{ x: number; y: number } | null>(null);
  const bugCursor = useRef<HTMLSpanElement>(null);
  const simulationKey = snapshot ? simulationStorageKey(snapshot.world.id) : '';
  const simulation = snapshot?.simulations.find(row => row.id === sessionStorage.getItem(simulationKey) && row.status === 'running');
  const canControl = !!connection && !!snapshot?.canSimulate && !busy;
  const placing = !!pickup && !!simulation && !!connection;
  const graph = useMemo(() => buildRepositoryGraph(snapshot?.entities, snapshot?.relations), [snapshot?.entities, snapshot?.relations]);
  const impact = presentSimulation(snapshot?.entities ?? [], snapshot?.states ?? [], simulation?.id);
  const presentation = withSelection(graph, impact.presentation, selected);

  useEffect(() => {
    if (!placing) return;
    const move = (event: PointerEvent) => {
      if (!bugCursor.current) return;
      bugCursor.current.style.left = `${event.clientX}px`;
      bugCursor.current.style.top = `${event.clientY}px`;
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPickup(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('keydown', cancel);
    };
  }, [placing]);

  async function selectNode(id: string | null) {
    if (!placing) {
      setSelected(current => current === id ? null : id);
      return;
    }
    const entity = snapshot?.entities.find(row => row.id === id && row.active && row.kind === 'service');
    if (!entity || !canControl || !connection || !simulation) return;
    setPickup(null);
    setSelected(null);
    setError('');
    setBusy(true);
    try {
      await connection.reducers.setBug({ simulationId: simulation.id, entity: entity.key });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function control() {
    if (!canControl || !connection || !snapshot) return;
    setBusy(true);
    setError('');
    try {
      if (simulation) {
        await connection.reducers.stopSimulation({ id: simulation.id });
        sessionStorage.removeItem(simulationKey);
      } else {
        const id = `sim-${crypto.randomUUID()}`;
        await connection.reducers.createSimulation({ worldId: snapshot.world.id, id, label: 'Dependency impact' });
        sessionStorage.setItem(simulationKey, id);
      }
      setSelected(null);
      setPickup(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`console${placing ? ' is-placing-bug' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Box size={25} strokeWidth={1.6} /></div>
          <b>LATTICE</b>
        </div>
        <div className="incident-heading">
          <h1>{snapshot?.world.repository ?? 'Dependency World'}</h1>
        </div>
        <div className="controls">
          <button type="button" className="bug-button" aria-label="Place bug" aria-pressed={placing}
            disabled={!canControl || !simulation} title={placing ? 'Cancel bug placement' : 'Place bug'} onClick={event => {
              if (placing) {
                setPickup(null);
                return;
              }
              const box = event.currentTarget.getBoundingClientRect();
              setPickup(event.detail
                ? { x: event.clientX, y: event.clientY }
                : { x: box.left + box.width / 2, y: box.top + box.height / 2 });
            }}>
            <Bug size={23} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button className={simulation ? undefined : 'primary'} onClick={() => void control()} disabled={!canControl}>
            {simulation ? <><RotateCcw size={16} /> Reset</> : <><Play size={15} fill="currentColor" /> Start</>}
          </button>
          {(error || feedError) && <p className="action-error" role="alert">{error || feedError}</p>}
        </div>
      </header>

      {placing && pickup && <span ref={bugCursor} className="bug-cursor" style={{ left: pickup.x, top: pickup.y }} aria-hidden="true">
        <Bug size={25} strokeWidth={2} />
      </span>}

      <section className="arena" aria-label="System state and agent activity">
        <div className="arena-corner nw" /><div className="arena-corner ne" />
        <div className="arena-corner sw" /><div className="arena-corner se" />
        <SystemMap graph={graph} presentation={presentation} selectedNodeId={selected} onSelectNode={id => void selectNode(id)} />

        {agents.map((config, index) => <AgentCard key={config.id} config={config} activity={snapshot?.messages[index]} />)}
      </section>

      {impact.origins > 0 && <section className="responses" aria-label="Simulation impact">
        <div className="response-grid">
          <article className="task P0"><h3>{impact.origins} fault {impact.origins === 1 ? 'origin' : 'origins'}</h3></article>
          <article className="task"><h3>{impact.potential} potentially affected</h3></article>
        </div>
      </section>}
    </main>
  );
}

function AgentCard({ config, activity }: { config: typeof agents[number]; activity?: AgentMessage }) {
  const Icon = config.icon;
  return (
    <article className={`agent-station agent-${config.id} ${config.color}`} aria-label={`Agent ${config.id}`}>
      <div className="agent-card">
        <div className="agent-avatar"><Icon strokeWidth={1.55} aria-hidden="true" /></div>
        <h2>Agent {config.id}</h2>
      </div>
      <div className="speech" role="status">
        {activity && <AgentSpeech key={activity.at} {...activity} />}
      </div>
    </article>
  );
}

const speechLifetime = 5200;

function AgentSpeech({ message, at }: AgentMessage) {
  const [remaining] = useState(() => speechLifetime - Math.max(0, Date.now() - at));
  const [visible, setVisible] = useState(remaining > 0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [remaining]);
  return visible ? <p className="speech-bubble">{message}</p> : null;
}
