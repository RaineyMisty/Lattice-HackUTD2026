import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowRight, ArrowUpRight, Bell, Check, CheckCheck, ChevronRight, CircleHelp, Code2, Database, FileText, Fingerprint, GitBranch, Layers3, LoaderCircle, LockKeyhole, Maximize2, Minus, Network, Play, Plus, RotateCcw, Search, Shield, ShieldAlert, Sparkles, Square, Terminal, Users, X, Zap } from 'lucide-react';
import type { AgentState, RiskStatus, WorldClient, WorldSnapshot } from '../../../packages/contracts/src/index';
import { createWorldClient } from './data/client';

const STATUS: Record<RiskStatus, { label: string; short: string }> = {
  unknown: { label: 'Awaiting evidence', short: 'Unknown' },
  possible: { label: 'Potential exposure', short: 'Investigating' },
  direct: { label: 'Directly affected', short: 'Direct impact' },
  downstream: { label: 'Potential downstream', short: 'Downstream' },
  unaffected: { label: 'Not affected', short: 'Unaffected' },
};
const AGENT_ICONS = { A: ShieldAlert, B: GitBranch, C: Layers3, D: Users };
const NODE_ICONS: Record<string, typeof Shield> = { auth: Fingerprint, checkout: LockKeyhole, merchant: Network, reporting: Activity };
const NODE_POS: Record<string, { x: number; y: number }> = { auth: { x: 218, y: 167 }, checkout: { x: 58, y: 320 }, merchant: { x: 391, y: 320 }, reporting: { x: 471, y: 149 } };
const phaseLabels = ['Incident injected', 'Agents investigate', 'World derives', 'Teams notified'];
const dateTime = (time: string) => new Date(time).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function App() {
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [pace, setPace] = useState<'normal' | 'fast'>('normal');
  const [selected, setSelected] = useState<string>('auth');
  const [modal, setModal] = useState<'evidence' | 'events' | 'architecture' | null>(null);
  const [focusedEvidence, setFocusedEvidence] = useState<string | null>(null);
  const [resetPrompt, setResetPrompt] = useState(false);
  const client = useRef<WorldClient | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      client.current = createWorldClient();
      unsubscribe = client.current.subscribe(next => {
        setWorld(current => !current || next.revision >= current.revision || !next.incident ? next : current);
        setError('');
      }, setError);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setModal(null); setResetPrompt(false); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const act = async (label: string, fn: (connection: WorldClient) => Promise<void>) => {
    if (!client.current) return;
    setBusy(label); setActionError('');
    try { await fn(client.current); } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(''); }
  };
  const active = world?.agents.some(agent => agent.status === 'reading' || agent.status === 'extracting') ?? false;
  const impacted = world?.assets.filter(asset => asset.status === 'direct' || asset.status === 'downstream').length ?? 0;
  const submitted = world?.agents.filter(agent => agent.evidenceCount > 0).length ?? 0;
  const complete = submitted === 4 && (world?.tasks.length ?? 0) > 0;
  const phase = !world?.incident ? -1 : complete ? 3 : impacted > 0 ? 2 : world.evidence.length > 0 || active ? 1 : 0;
  const asset = world?.assets.find(item => item.id === selected);
  const offline = !world || !!error;
  const openEvidence = (id?: string) => { setFocusedEvidence(id ?? null); setModal('evidence'); };

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Lattice home"><span className="brand-mark"><Layers3 size={22} strokeWidth={1.8} /></span><span>Lattice<span className="brand-dot">.</span></span></a>
      <span className="header-divider" />
      <div className="workspace"><span className="company-avatar">A</span><span>ASTER <span className="slash">/</span> <span className="muted">Security Operations</span></span></div>
      <nav className="main-nav" aria-label="Primary navigation">
        <button className={modal ? '' : 'active'} onClick={() => setModal(null)}>Command center</button>
        <button className={modal === 'evidence' ? 'active' : ''} onClick={() => openEvidence()}>Evidence <span>{world?.evidence.length ?? 0}</span></button>
      </nav>
      <div className="header-right"><span className="environment"><span className="status-dot" />DEMO ENVIRONMENT</span><button className="icon-button help-button" title="How Lattice works" aria-label="How Lattice works" onClick={() => setModal('architecture')}><CircleHelp size={18} /></button><span className="user-avatar">AC</span></div>
    </header>

    <main>
      <section className="page-intro">
        <div className="intro-copy"><div className="eyebrow"><span className="tiny-square" /> CONTINUUM <span className="eyebrow-divider">/</span> LIVE INCIDENT WORLD</div><h1>Every signal. One shared reality.</h1><p>Independent agents investigate. The database connects the dots.</p></div>
        <div className="intro-controls"><div className="connection"><span className={`status-dot ${offline ? 'warning' : 'green pulse'}`} />{offline ? 'Awaiting connection' : world.mode === 'local' ? 'Local simulation live' : 'SpacetimeDB live'}<span className="revision">REV {String(world?.revision ?? 0).padStart(3, '0')}</span></div><div className="action-row"><button className="button secondary" title="Reset this fictional demo" disabled={busy !== '' || offline} onClick={() => setResetPrompt(true)}><RotateCcw size={14} /> Reset</button><button className="button primary" disabled={!!busy || offline || active} onClick={() => act(world?.incident ? 'start' : 'inject', c => world?.incident ? c.start(pace) : c.inject())}>{busy ? <LoaderCircle className="spin" size={15} /> : world?.incident ? <Play size={15} fill="currentColor" /> : <Zap size={16} />} {world?.incident ? complete ? 'Replay investigation' : 'Run investigation' : 'Inject Incident'}</button></div></div>
      </section>

      {(error || actionError) && <div className="error-banner" role="alert"><ShieldAlert size={16} /><span>{actionError || error}</span>{actionError && <button className="icon-button" onClick={() => setActionError('')} aria-label="Dismiss error"><X size={14} /></button>}</div>}

      <section className="overview-strip" aria-label="Incident overview">
        <div className="overview-identity"><div className={`incident-symbol ${world?.incident ? 'critical' : ''}`}><ShieldAlert size={22} /></div><div><span className="overline">ACTIVE OPERATION</span><strong>{world?.incident ? 'TokenGate response' : 'Standing by for a signal'}<span className={`small-badge ${world?.incident ? 'critical' : ''}`}>{world?.incident ? 'Critical incident' : 'Ready'}</span></strong></div></div>
        <Metric count={world?.incident ? 1 : 0} label="Incident" icon={<Shield size={16} />} />
        <Metric count={world?.agents.length ?? 4} label="Investigation agents" icon={<Sparkles size={16} />} />
        <Metric count={impacted} label="Affected systems" icon={<Network size={16} />} accent={impacted > 0} />
        <Metric count={world?.tasks.length ?? 0} label="Response tasks" icon={<CheckCheck size={16} />} />
      </section>

      <div className="command-layout">
        <aside className="agents-panel panel">
          <div className="panel-heading"><h2><Sparkles size={16} /> Investigation agents</h2><span className="count-badge">04</span></div>
          <div className="panel-description">Four perspectives. One source of truth.</div>
          <div className="agent-list">{world ? world.agents.map(agent => <AgentCard key={agent.id} agent={agent} disabled={!!busy || !world.incident || offline} onRun={() => act(`agent-${agent.id}`, c => c.runAgent(agent.id))} onEvidence={() => openEvidence(world.evidence.find(item => item.agentId === agent.id)?.id)} />) : <div className="loading-agents">{['A', 'B', 'C', 'D'].map(id => <div className="agent-placeholder" key={id}><span>{id}</span><div /><div /></div>)}</div>}</div>
          <div className="agent-controls"><label className="pace-switch"><input type="checkbox" checked={pace === 'fast'} onChange={event => setPace(event.target.checked ? 'fast' : 'normal')} disabled={active} /><span className="toggle-track"><span /></span><span>Fast demo</span><span className="muted">{pace === 'fast' ? '~6s' : '~35s'} run</span></label><button className="stop-button" disabled={!!busy || offline || !world?.incident || world.agentsStopped} onClick={() => act('stop', c => c.stopAgents())}><Square size={11} fill="currentColor" />{world?.agentsStopped ? 'All agents offline' : 'Stop all agents'}</button></div>
          <div className="agent-boundary"><div className="boundary-icon"><Database size={17} /></div><div><strong>Evidence in. Intelligence out.</strong><p>Agents only read sources and submit facts. Database rules own every decision.</p><button onClick={() => setModal('architecture')}>Explore the architecture <ArrowUpRight size={12} /></button></div></div>
          <div className="agent-footer"><LockKeyhole size={12} /><span>No agent-to-agent communication</span></div>
        </aside>

        <section className="world-panel panel">
          <div className="world-heading"><div><h2><Network size={17} /> Dependency world</h2><p>ASTER Commerce <span>·</span> Production</p></div><span className="live-chip"><span className={`status-dot ${active ? 'purple pulse' : 'green'}`} />{active ? 'Evolving' : complete ? 'Synchronized' : 'Live world'}</span></div>
          <div className="world-toolbar"><div className="world-tab"><span className="tiny-square" /> Asset topology</div><button onClick={() => openEvidence()}><FileText size={12} />{world?.evidence.length ?? 0} evidence records<ChevronRight size={12} /></button></div>
          <DependencyGraph world={world} selected={selected} onSelect={setSelected} />
          <div className="graph-legend"><span><i className="legend-dot direct" />Direct impact</span><span><i className="legend-dot downstream" />Downstream</span><span><i className="legend-dot unaffected" />Unaffected</span><span><i className="legend-dot unknown" />Unknown</span></div>
          <div className="asset-inspector">{asset ? <><div className={`inspector-icon ${asset.status}`}><Shield size={17} /></div><div className="inspector-content"><div><strong>{asset.name}</strong><span className={`text-status ${asset.status}`}>{STATUS[asset.status].label}</span></div><p>{asset.reason || 'Waiting for investigation evidence to establish this asset’s security state.'}</p>{asset.impactPath.length > 0 && <span className="impact-path">{asset.impactPath.map(id => world?.assets.find(a => a.id === id)?.name ?? id).join(' → ')}</span>}</div><button className="evidence-link" disabled={asset.evidenceIds.length === 0} onClick={() => openEvidence(asset.evidenceIds[0])}><FileText size={13} />{asset.evidenceIds.length}<ChevronRight size={13} /></button></> : <><Search size={18} /><p>Select an asset to inspect its evidence and impact path.</p></>}</div>
          <div className={`world-persistence ${world?.agentsStopped ? 'persisted' : ''}`}><Database size={13} /><span>{world?.agentsStopped ? 'Agents are offline. The world and response tasks persist.' : 'Every state change is derived and stored by the database.'}</span><span className="persist-tag">{world?.mode === 'spacetimedb' ? 'REDUCERS' : 'LOCAL RULE ENGINE'}</span></div>
        </section>

        <aside className="response-column">
          <section className="incident-panel panel"><div className="panel-heading"><h2><ShieldAlert size={16} /> Incident brief</h2><span className={`small-badge ${world?.incident ? 'critical' : ''}`}>{world?.incident ? 'CRITICAL' : 'STANDBY'}</span></div><div className="incident-content"><div className="incident-id">{world?.incident?.id ?? 'DEMO-SEC-001'}<ArrowUpRight size={13} /></div><h3>TokenGate<br />Authentication Bypass</h3><p>Legacy TokenGate versions may allow attackers to bypass authentication.</p><div className="version-grid"><div><span>AFFECTED</span><strong className="bad-version">1.8.0 – 1.8.2</strong></div><ArrowRight size={14} /><div><span>PATCH AVAILABLE</span><strong className="good-version">1.8.3 <Check size={12} /></strong></div></div><div className="fiction-note"><CircleHelp size={11} />Fictional advisory · reproducible demo</div></div></section>
          <section className="inbox-panel panel"><div className="panel-heading"><h2><Bell size={16} /> Department inbox</h2><span className={`count-badge ${(world?.tasks.length ?? 0) ? 'purple-badge' : ''}`}>{world?.tasks.length ?? 0}</span></div><div className="inbox-subtitle"><span>Incident response tasks</span><span>{world?.tasks.length ?? 0} assigned</span></div><div className="task-list">{world?.tasks.length ? world.tasks.map(task => <button className={`task-card priority-${task.priority}`} key={task.id} onClick={() => { setSelected(task.assetId); openEvidence(task.evidenceIds[0]); }}><div className="task-top"><span className={`priority ${task.priority}`}>{task.priority}</span><span>{task.department}</span><ArrowUpRight size={13} /></div><h4>{task.assetName}</h4><p>{task.instruction}</p><div className="task-reason"><GitBranch size={11} /><span>{task.reason}</span></div><div className="task-meta"><span><CheckCheck size={11} />{world.notifications.some(note => note.taskId === task.id) ? 'Notification delivered' : 'Task generated'}</span><span>{dateTime(task.createdAt)}</span></div></button>) : <div className="empty-inbox"><div className="empty-inbox-art"><Bell size={24} /><span /><span /></div><strong>Ready when the world is.</strong><p>Response tasks appear here when database rules identify affected assets and their owners.</p><span className="waiting"><span className="status-dot" />Awaiting derived impact</span></div>}</div><div className="inbox-footer"><Zap size={12} />Generated by database rules<span>↗</span></div></section>
        </aside>
      </div>

      <section className="bottom-grid"><div className="activity-panel panel"><div className="panel-heading"><h2><Terminal size={15} /> World activity</h2><button className="text-button" onClick={() => setModal('events')}>View all <ArrowUpRight size={12} /></button></div><div className="activity-list">{world?.events.length ? world.events.slice(-3).reverse().map(event => <div className="activity-row" key={event.id}><time>{dateTime(event.at)}</time><span className={`event-label ${event.type}`}>{event.type === 'derivation' ? 'RULE' : event.type.toUpperCase()}</span><p>{event.message}</p></div>) : <div className="activity-empty"><span className="terminal-cursor" />Waiting for an incident. Inject a signal to begin the investigation.</div>}</div></div><div className="sequence-panel panel"><div className="panel-heading"><h2><Play size={14} /> The 90-second story</h2><span className="subtle">ONE INCIDENT. FOUR AGENTS.</span></div><div className="story-sequence">{phaseLabels.map((label, index) => <div className={`story-step ${index <= phase ? 'reached' : ''} ${index === phase ? 'current' : ''}`} key={label}><div className="step-dot">{index < phase ? <Check size={11} /> : `0${index + 1}`}</div><strong>{label}</strong><span>{['0–15s', '15–45s', '45–65s', '65–90s'][index]}</span></div>)}</div></div></section>

      <footer className="page-footer"><span><span className="footer-logo"><Layers3 size={13} /></span>Lattice <span className="footer-slash">/</span> Cyber Incident Command Center</span><button onClick={() => setModal('architecture')}><span className={`status-dot ${world?.mode === 'spacetimedb' ? 'green' : 'purple'}`} />{world?.mode === 'spacetimedb' ? 'SpacetimeDB connected' : 'Local simulator · SpacetimeDB integration pending'}<ArrowUpRight size={11} /></button><span>ASTER COMMERCE · DEMO DATA</span></footer>
    </main>

    {modal && <Modal title={modal === 'evidence' ? 'Evidence repository' : modal === 'events' ? 'World activity ledger' : 'One shared world. Clear boundaries.'} subtitle={modal === 'evidence' ? 'Raw sources and submitted facts. Every conclusion is traceable.' : modal === 'events' ? 'Persistent database events, from first signal to department notification.' : 'Agents contribute facts. The database turns them into coordinated response.'} onClose={() => setModal(null)}>{modal === 'evidence' ? <EvidenceView world={world} focusedEvidence={focusedEvidence} /> : modal === 'events' ? <div className="ledger">{world?.events.length ? [...world.events].reverse().map(event => <div className="ledger-event" key={event.id}><time>{dateTime(event.at)}</time><span className={`event-label ${event.type}`}>{event.type}</span><p>{event.message}</p></div>) : <div className="empty-modal">No events yet. Inject the fictional incident to begin.</div>}</div> : <Architecture world={world} />}</Modal>}
    {resetPrompt && <Modal title="Start a fresh incident world?" subtitle="Reset clears this demo’s persisted evidence, derived states, response tasks and activity." onClose={() => setResetPrompt(false)}><div className="reset-actions"><button className="button secondary" onClick={() => setResetPrompt(false)}>Keep current world</button><button className="button primary" onClick={() => { setResetPrompt(false); act('reset', c => c.reset()); }}>Reset demo</button></div></Modal>}
  </div>;
}

function Metric({ count, label, icon, accent }: { count: number; label: string; icon: ReactNode; accent?: boolean }) { return <div className={`metric ${accent ? 'metric-accent' : ''}`}><strong>{String(count).padStart(2, '0')}</strong><span>{icon}{label}</span></div>; }

function AgentCard({ agent, disabled, onRun, onEvidence }: { agent: AgentState; disabled: boolean; onRun: () => void; onEvidence: () => void }) {
  const Icon = AGENT_ICONS[agent.id];
  const running = agent.status === 'reading' || agent.status === 'extracting';
  const done = agent.evidenceCount > 0;
  const label = { idle: 'Ready', reading: 'Reading source', extracting: 'Extracting facts', submitted: 'Submitted', stopped: 'Offline', error: 'Error' }[agent.status];
  return <article className={`agent-card ${running ? 'running' : ''} ${done ? 'done' : ''}`}><div className="agent-card-top"><span className={`agent-icon agent-${agent.id}`}><Icon size={17} /><span>{agent.id}</span></span><div><h3>{agent.role.replace(/ Analyst$/i, '')}</h3><span className="agent-identity">AGENT {agent.id}</span></div><button title={`Run Agent ${agent.id}`} aria-label={`Run Agent ${agent.id}`} className="agent-play" disabled={disabled || running} onClick={onRun}>{running ? <LoaderCircle className="spin" size={13} /> : <Play size={12} />}</button></div><p className="agent-message" title={agent.message}>{agent.message || 'Waiting for an incident to investigate.'}</p><div className="agent-card-footer"><span className={`agent-status ${agent.status}`}><span className="status-dot" />{label}</span><button disabled={!done} onClick={onEvidence}>{done ? <Check size={11} /> : <FileText size={10} />}{agent.evidenceCount} {agent.evidenceCount === 1 ? 'record' : 'records'}<ChevronRight size={11} /></button></div></article>;
}

function DependencyGraph({ world, selected, onSelect }: { world: WorldSnapshot | null; selected: string; onSelect: (id: string) => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const vulnerability = world?.evidence.find(item => item.payload.kind === 'vulnerability');
  const edges = world?.dependencies ?? [];
  const byId = new Map(world?.assets.map(asset => [asset.id, asset]) ?? []);
  const positions = { ...NODE_POS, tokengate: { x: 243, y: 26 } };
  const endpoint = (id: string) => { const position = positions[id as keyof typeof positions]; return position ? { x: position.x + (id === 'tokengate' ? 85 : 96), y: position.y + 38 } : null; };
  return <div className="graph-area"><div className="graph-corner top-left" /><div className="graph-corner bottom-right" /><div className="graph-coordinate">WORLD / ASTER-01</div><svg viewBox="0 0 700 440" className="dependency-svg" aria-label="Enterprise asset dependency graph" onPointerDown={event => { if ((event.target as Element).closest('button')) return; drag.current = { x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current) { const rect = event.currentTarget.getBoundingClientRect(); setPan({ x: drag.current.startX + (event.clientX - drag.current.x) * 700 / rect.width, y: drag.current.startY + (event.clientY - drag.current.y) * 440 / rect.height }); } }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs><marker id="arrow-neutral" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="none" stroke="#676374" strokeWidth="1.2" /></marker><marker id="arrow-amber" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="none" stroke="#dba268" strokeWidth="1.2" /></marker><marker id="arrow-red" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="none" stroke="#df777f" strokeWidth="1.2" /></marker></defs>
      <g transform={`translate(${pan.x + 350} ${pan.y + 220}) scale(${zoom}) translate(-350 -220)`}>
      {edges.map(edge => {
        const from = endpoint(edge.from), to = endpoint(edge.to); if (!from || !to) return null;
        const status = byId.get(edge.from)?.status ?? 'unknown';
        const color = status === 'direct' ? 'red' : status === 'downstream' ? 'amber' : 'neutral';
        let path = '';
        if (edge.to === 'auth') { path = `M ${from.x} ${from.y - 39} L ${from.x} ${from.y - 69} Q ${from.x} ${from.y - 78} ${from.x + (from.x < to.x ? 10 : -10)} ${from.y - 78} L ${to.x + (from.x < to.x ? -36 : 36)} ${from.y - 78} Q ${to.x} ${from.y - 78} ${to.x} ${to.y + 48}`; }
        else if (edge.from === 'reporting') { path = `M ${from.x} ${from.y - 39} L ${from.x} ${to.y + 1} Q ${from.x} ${to.y - 10} ${from.x - 11} ${to.y - 10} L ${to.x + 92} ${to.y - 10}`; }
        else { path = `M ${from.x} ${from.y - 39} L ${from.x} ${to.y + 48}`; }
        return <g key={`${edge.from}-${edge.to}`} className={`graph-edge ${color}`}><path d={path} markerEnd={`url(#arrow-${color})`} /><path className="edge-flow" d={path} />{edge.to === 'auth' && <text x={from.x + (from.x < to.x ? 37 : -59)} y={from.y - 88}>depends on</text>}{edge.from === 'reporting' && <text x={from.x - 74} y={to.y - 21}>{status === 'unaffected' && byId.get(edge.from)?.version ? 'patched version' : 'uses component'}</text>}</g>;
      })}
      <foreignObject x="243" y="26" width="172" height="81"><div className={`component-node ${vulnerability ? 'known' : ''}`}><div className="component-top"><Code2 size={16} /><strong>TokenGate</strong><span className="status-dot" /></div><div className="component-bottom">AUTH COMPONENT <span>{vulnerability ? 'DEMO / 001' : 'UNVERIFIED'}</span></div></div></foreignObject>
      {(world?.assets ?? []).map(asset => { const position = NODE_POS[asset.id]; if (!position) return null; const Icon = NODE_ICONS[asset.id] ?? Shield; return <foreignObject key={asset.id} x={position.x} y={position.y} width="198" height="94" style={{ overflow: 'visible' }}><button className={`asset-node ${asset.status} ${selected === asset.id ? 'selected' : ''}`} onClick={() => onSelect(asset.id)} aria-label={`${asset.name}: ${STATUS[asset.status].label}`} aria-pressed={selected === asset.id}><div className="asset-node-main"><span className="node-icon"><Icon size={18} /></span><div><strong>{asset.name}</strong><span>{asset.version ? `TokenGate ${asset.version}` : asset.subtitle}</span></div>{asset.priority && <span className="node-priority">{asset.priority}</span>}</div><div className="asset-node-footer"><span><span className="status-dot" />{STATUS[asset.status].short}</span><ArrowUpRight size={11} /></div></button></foreignObject>; })}
      {!world && <text x="350" y="235" textAnchor="middle" className="graph-loading">Connecting to the incident world…</text>}
      </g></svg><div className="graph-controls"><button aria-label="Zoom in graph" title="Zoom in" disabled={zoom >= 1.5} onClick={() => setZoom(value => Math.min(1.5, value + 0.15))}><Plus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom out graph" title="Zoom out" disabled={zoom <= 0.7} onClick={() => setZoom(value => Math.max(0.7, value - 0.15))}><Minus size={14} /></button><i /><button aria-label="Reset graph view" title="Fit to view" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize2 size={13} /></button></div><div className="graph-hint">Drag to pan <span>·</span> Select to inspect</div></div>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) { const content = useRef<HTMLDivElement>(null); useEffect(() => { const last = document.activeElement as HTMLElement | null; content.current?.focus(); const trap = (event: KeyboardEvent) => { if (event.key !== 'Tab' || !content.current) return; const items = content.current.querySelectorAll<HTMLElement>('button:not(:disabled), a, input, [tabindex="0"]'); const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }; document.addEventListener('keydown', trap); return () => { document.removeEventListener('keydown', trap); last?.focus(); }; }, []); return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={content}><div className="modal-header"><div><span className="eyebrow">LATTICE / COMMAND CENTER</span><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={21} /></button></div><div className="modal-body">{children}</div></div></div>; }

function EvidenceView({ world, focusedEvidence }: { world: WorldSnapshot | null; focusedEvidence: string | null }) {
  const [selectedSource, setSelectedSource] = useState<string | null>(() => world?.evidence.find(item => item.id === focusedEvidence)?.sourceId ?? world?.sources[0]?.id ?? null);
  const source = world?.sources.find(item => item.id === selectedSource);
  const records = world?.evidence.filter(item => item.sourceId === selectedSource) ?? [];
  const readable = (body: string) => { try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } };
  return world?.sources.length ? <div className="evidence-browser"><div className="source-list">{world.sources.map(item => <button className={selectedSource === item.id ? 'selected' : ''} key={item.id} onClick={() => setSelectedSource(item.id)}><FileText size={16} /><span><strong>{item.title}</strong><small>{item.kind}</small></span><ChevronRight size={13} /></button>)}</div><div className="source-detail"><div className="source-heading"><span className="overline">DATABASE SOURCE RECORD</span><span className="source-id">{source?.id}</span></div><h3>{source?.title}</h3><pre className="raw-source">{source ? readable(source.body) : 'Select a source record.'}</pre><div className="source-heading"><span className="overline">SUBMITTED EVIDENCE</span><span>{records.length} records</span></div>{records.length ? records.map(record => <div className="evidence-record" key={record.id}><div><strong><Check size={13} />Agent {record.agentId} · {record.payload.kind}</strong><time>{dateTime(record.submittedAt)}</time></div><pre>{JSON.stringify(record.payload, null, 2)}</pre><span className="source-id">{record.id}</span></div>) : <div className="no-evidence"><Search size={18} /><p>No evidence submitted from this source yet.</p></div>}</div></div> : <div className="empty-modal">Source records will be available when the database connects.</div>;
}

function Architecture({ world }: { world: WorldSnapshot | null }) {
  const checks = [
    { label: 'Four independent agents read and submit through the database', local: world?.agents.filter(a => a.evidenceCount > 0).length === 4 },
    { label: 'Vulnerability, dependencies, deployments and ownership are joined', local: world?.evidence.length === 4 },
    { label: 'Direct, downstream and unaffected systems are distinguished', local: world?.assets.some(a => a.status === 'direct') && world?.assets.some(a => a.status === 'downstream') && world?.assets.some(a => a.status === 'unaffected') },
    { label: 'Three department response tasks and notifications are generated', local: world?.tasks.length === 3 && world?.notifications.length === 3 },
    { label: 'The incident world remains queryable with every agent offline', local: world?.agentsStopped && world?.tasks.length === 3 },
  ];
  return <div className="architecture-content"><div className="architecture-flow"><div><Sparkles size={24} /><strong>4 independent agents</strong><span>Read sources · submit evidence</span></div><ArrowRight size={20} /><div className="database-core"><Database size={26} /><strong>Database rules</strong><span>Derive impact · assign priority</span></div><ArrowRight size={20} /><div><Bell size={24} /><strong>Coordinated response</strong><span>Persisted world · department tasks</span></div></div><div className="integration-note"><Code2 size={19} /><div><strong>{world?.mode === 'spacetimedb' ? 'SpacetimeDB adapter active' : 'You are viewing the local reducer simulator'}</strong><p>{world?.mode === 'spacetimedb' ? 'All displayed states come from the connected database subscription.' : 'The server runs the same domain rules used by the SpacetimeDB module and persists results locally. Live SpacetimeDB and model API credentials are intentionally not connected.'}</p></div></div><div className="dod-heading"><h3>Definition of Done</h3><span>{checks.filter(check => check.local).length}/5 {world?.mode === 'spacetimedb' ? 'observed' : 'local checks'}</span></div><div className="dod-checks">{checks.map(check => <div key={check.label}><span className={`check-circle ${check.local ? 'checked' : ''}`}>{check.local ? <Check size={13} /> : null}</span><p>{check.label}</p><span>{check.local ? 'Observed' : 'Pending'}</span></div>)}</div><p className="verification-note">{world?.mode === 'spacetimedb' ? 'Validate the deployment and identities against docs/database.md before presenting the live integration.' : 'SpacetimeDB acceptance remains pending until you connect the generated bindings and run this flow against real reducers. Local checks do not certify a live deployment.'}</p></div>;
}

export default App;
