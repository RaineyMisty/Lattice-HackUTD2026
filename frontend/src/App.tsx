import { useEffect, useMemo, useState } from 'react';
import { Box, Crosshair, GitBranch, Layers3, Play, RotateCcw, Users } from 'lucide-react';
import { DbConnection, tables } from '../../db/client';
import type { AgentState, WorldSnapshot } from '../../shared/types';

import SystemMap from './map/SystemMap';
import { buildTopology, incidentRegion } from './map/topology';

const agents = [
  { id: 'A', callsign: 'Vulnerability', icon: Crosshair, color: 'violet' },
  { id: 'B', callsign: 'Dependency', icon: GitBranch, color: 'cyan' },
  { id: 'C', callsign: 'Deployment', icon: Layers3, color: 'indigo' },
  { id: 'D', callsign: 'Ownership', icon: Users, color: 'mint' },
] as const;
const sourceNames: Record<AgentState['sourceKind'], string> = {
  advisory: 'advisory', dependencies: 'dependency map',
  deployments: 'deployment records', ownership: 'ownership records',
};
const workMessages: Record<AgentState['sourceKind'], string> = {
  advisory: 'Extracting advisory details…',
  dependencies: 'Mapping dependencies…',
  deployments: 'Checking versions…',
  ownership: 'Identifying owners…',
};
const uri = import.meta.env.VITE_LATTICE_DB_URL || 'http://127.0.0.1:3000';
const database = import.meta.env.VITE_LATTICE_DATABASE || 'lattice-demo';
const tokenKey = `lattice.operator:${uri}:${database}`;
const suppliedToken = new URLSearchParams(window.location.hash.slice(1)).get('operator');
if (suppliedToken) {
  sessionStorage.setItem(tokenKey, suppliedToken);
  history.replaceState(null, '', location.pathname + location.search);
}

export default function App() {
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [connection, setConnection] = useState<DbConnection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const map = useMemo(() => buildTopology(world), [world]);

  useEffect(() => {
    const token = sessionStorage.getItem(tokenKey);
    if (!token) return;

    let disposed = false;
    const fail = (message: string) => {
      if (disposed) return;
      setConnection(null);
      setError(message);
    };
    const conn = DbConnection.builder().withUri(uri).withDatabaseName(database).withToken(token)
      .onConnect(client => {
        if (disposed) return;
        const read = () => {
          if (disposed) return;
          const [snapshot] = client.db.dashboardWorld.iter();
          if (!snapshot) {
            fail('This identity is not registered as an incident operator.');
            return;
          }
          setWorld(JSON.parse(snapshot.snapshotJson) as WorldSnapshot);
          setConnection(client);
        };
        const changed = () => queueMicrotask(read);
        client.db.dashboardWorld.onInsert(changed);
        client.db.dashboardWorld.onUpdate(changed);
        client.db.dashboardWorld.onDelete(changed);
        client.subscriptionBuilder().onApplied(read)
          .onError(() => fail('Unable to subscribe to the incident.'))
          .subscribe(tables.dashboardWorld);
      })
      .onConnectError((_ctx, cause) => fail(cause.message))
      .onDisconnect(() => fail('Telemetry disconnected.'))
      .build();

    return () => {
      disposed = true;
      conn.disconnect();
    };
  }, []);

  async function control(action: 'start' | 'reset') {
    if (!connection || busy) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'start') await connection.reducers.injectIncident({});
      else await connection.reducers.resetDemo({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="console">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Box size={25} strokeWidth={1.6} /></div>
          <b>LATTICE</b>
        </div>
        <div className="incident-heading">
          <h1>{world?.incident?.title ?? 'TokenGate incident response'}</h1>
        </div>
        <div className="controls">
          {world?.incident ? (
            <button onClick={() => void control('reset')} disabled={!connection || busy}><RotateCcw size={16} /> Reset</button>
          ) : (
            <button className="primary" onClick={() => void control('start')} disabled={!connection || busy}><Play size={15} fill="currentColor" /> Start</button>
          )}
          {error && <p className="action-error" role="alert">{error}</p>}
        </div>
      </header>

      <section className="arena" aria-label="System state and agent activity">
        <div className="arena-corner nw" /><div className="arena-corner ne" />
        <div className="arena-corner sw" /><div className="arena-corner se" />
        <SystemMap nodes={map.nodes} links={map.links} homeRegion={incidentRegion} />

        {agents.map(config => (
          <AgentCard key={config.id} config={config} agent={world?.incident ? world.agents.find(agent => agent.id === config.id) : undefined} />
        ))}

      </section>

      {!!world?.notifications.length && <section className="responses" aria-label="Department responses">
        <div className="response-grid">
          {world.notifications.map(notification => {
            const task = world.tasks.find(item => item.id === notification.taskId);
            if (!task) return null;
            return (
              <article key={notification.id} className={`task ${task.priority}`} title={task.instruction}>
                <div className="task-top"><span className="priority">{task.priority}</span><span>{notification.department}</span></div>
                <h3>{task.title || task.assetName}</h3>
              </article>
            );
          })}
        </div>
      </section>}
    </main>
  );
}

function AgentCard({ config, agent }: { config: typeof agents[number]; agent?: AgentState }) {
  const Icon = config.icon;
  const message = agent && (
    agent.status === 'reading' ? `Reading ${sourceNames[agent.sourceKind]}…`
      : agent.status === 'extracting' ? workMessages[agent.sourceKind]
      : agent.status === 'submitted' ? 'Evidence submitted.'
      : agent.status === 'error' ? agent.message : ''
  );
  return (
    <article className={`agent-station agent-${config.id} ${config.color}`} aria-label={`Agent ${config.id}: ${config.callsign}`}>
      <div className="agent-card">
        <div className="agent-avatar"><Icon strokeWidth={1.55} aria-hidden="true" /></div>
        <h2>{config.callsign}</h2>
      </div>
      <div className="speech" role="status">
        {message && agent?.updatedAt && (
          <AgentSpeech key={`${agent.status}:${agent.updatedAt}`} message={message} at={agent.updatedAt} />
        )}
      </div>
    </article>
  );
}

const speechLifetime = 5200;

function AgentSpeech({ message, at }: { message: string; at: string }) {
  const [remaining] = useState(() => speechLifetime - Math.max(0, Date.now() - Date.parse(at)));
  const [visible, setVisible] = useState(remaining > 0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setVisible(false), remaining);
    return () => window.clearTimeout(timer);
  }, [remaining]);
  return visible ? <p className="speech-bubble">{message}</p> : null;
}
