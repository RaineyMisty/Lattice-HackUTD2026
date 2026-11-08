import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Box, Bug, Crosshair, GitBranch, Layers3, Play, RotateCcw, Users, Wrench } from 'lucide-react';

import RepositoryPicker from './RepositoryPicker';
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
const demoLabel = import.meta.env.VITE_LATTICE_DEMO_LABEL;
const emptyMessages: AgentMessage[] = [];
type Tool = 'bug' | 'wrench';

export default function App() {
  const { snapshot, connection, error: feedError, worlds, worldId } = useWorldFeed();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pickup, setPickup] = useState<{ tool: Tool; x: number; y: number } | null>(null);
  const bugCursor = useRef<HTMLSpanElement>(null);
  const simulationKey = snapshot ? simulationStorageKey(snapshot.world.id) : '';
  const simulation = snapshot?.simulations.find(row => row.id === sessionStorage.getItem(simulationKey) && row.status === 'running');
  const canControl = !!connection && !!snapshot?.canSimulate && !busy;
  const hasActiveEntity = snapshot?.entities.some(row => row.active);
  const placing = !!pickup && !!simulation && !!connection;
  const repairing = placing && pickup?.tool === 'wrench';
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

  function pickTool(tool: Tool, event: MouseEvent<HTMLButtonElement>) {
    if (placing && pickup?.tool === tool) {
      setPickup(null);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    setPickup(event.detail
      ? { tool, x: event.clientX, y: event.clientY }
      : { tool, x: box.left + box.width / 2, y: box.top + box.height / 2 });
  }

  async function selectNode(id: string | null) {
    if (!placing) {
      setSelected(current => current === id ? null : id);
      return;
    }
    const entity = snapshot?.entities.find(row => row.id === id && row.active
      && (!repairing || impact.presentation.nodes?.[row.id]?.tone === 'warning'));
    if (!entity || !canControl || !connection || !simulation) return;
    setPickup(null);
    setSelected(null);
    setError('');
    setBusy(true);
    try {
      const args = { simulationId: simulation.id, entity: entity.key };
      if (repairing) await connection.reducers.clearBug(args);
      else await connection.reducers.setBug(args);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function control() {
    if (!canControl || !connection || !snapshot) return;
    if (!simulation && demoLabel && import.meta.env.VITE_LATTICE_DEMO_MODEL_READY === false) {
      setError('Set NVIDIA_API_KEY in PowerShell and restart the dev server');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (simulation) {
        await connection.reducers.stopSimulation({ id: simulation.id });
        sessionStorage.removeItem(simulationKey);
      } else {
        const id = `sim-${crypto.randomUUID()}`;
        await connection.reducers.createSimulation({ worldId: snapshot.world.id, id, label: demoLabel || 'Dependency impact' });
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
          <RepositoryPicker worlds={worlds} worldId={worldId} onSelect={id => {
            const url = new URL(location.href);
            url.searchParams.set('world', id);
            location.assign(url);
          }} />
        </div>
        <div className="controls">
          <button type="button" className="bug-button" aria-label="Place bug" aria-pressed={placing && !repairing}
            disabled={!canControl || !simulation || !hasActiveEntity} title="Place bug" onClick={event => pickTool('bug', event)}>
            <Bug size={23} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className="bug-button wrench-button" aria-label="Clear bug" aria-pressed={repairing}
            disabled={!canControl || !simulation || !impact.origins} title="Clear bug" onClick={event => pickTool('wrench', event)}>
            <Wrench size={21} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button className={simulation ? undefined : 'primary'} onClick={() => void control()} disabled={!canControl}
            title={demoLabel && snapshot && !snapshot.canSimulate ? 'Waiting for the Git working tree to match this commit' : undefined}>
            {simulation ? <><RotateCcw size={16} /> Reset</> : <><Play size={15} fill="currentColor" /> Start</>}
          </button>
          {(error || feedError) && <p className="action-error" role="alert">{error || feedError}</p>}
        </div>
      </header>

      {placing && pickup && <span ref={bugCursor} className={`bug-cursor${repairing ? ' repair-cursor' : ''}`} style={{ left: pickup.x, top: pickup.y }} aria-hidden="true">
        {repairing ? <Wrench size={24} strokeWidth={2} /> : <Bug size={25} strokeWidth={2} />}
      </span>}

      <section className="arena" aria-label="System state and agent activity">
        <div className="arena-corner nw" /><div className="arena-corner ne" />
        <div className="arena-corner sw" /><div className="arena-corner se" />
        <SystemMap graph={graph} presentation={presentation} placingBug={placing} selectedNodeId={selected} onSelectNode={id => void selectNode(id)} />

        {agents.map((config, index) => <AgentCard key={config.id} config={config} activity={snapshot?.messages[index]} />)}
        {impact.origins > 0 && <section className="responses" aria-label="Simulation impact">
          <div className="response-grid">
            <article className="task P0"><h3>{impact.origins} fault {impact.origins === 1 ? 'origin' : 'origins'}</h3></article>
            <article className="task"><h3>{impact.potential} potentially affected</h3></article>
          </div>
        </section>}
      </section>
    </main>
  );
}

function AgentCard({ config, activity = emptyMessages }: { config: typeof agents[number]; activity?: AgentMessage[] }) {
  const Icon = config.icon;
  return (
    <article className={`agent-station agent-${config.id} ${config.color}`} aria-label={`Agent ${config.id}`}>
      <div className="agent-card">
        <div className="agent-avatar"><Icon strokeWidth={1.55} aria-hidden="true" /></div>
        <h2>Agent {config.id}</h2>
      </div>
      <div className="speech" role="status">
        <AgentSpeech activity={activity} />
      </div>
    </article>
  );
}

function AgentSpeech({ activity }: { activity: AgentMessage[] }) {
  const [index, setIndex] = useState(0);
  const next = activity[index];
  useEffect(() => {
    if (!next) return;
    const timer = window.setTimeout(() => setIndex(index + 1), 2300);
    return () => window.clearTimeout(timer);
  }, [index, next]);
  return next ? <p className="speech-bubble" key={next.id}>{next.message}</p> : null;
}
