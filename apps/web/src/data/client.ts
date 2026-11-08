import type { AgentId, WorldClient, WorldSnapshot } from '../../../../packages/contracts/src/index';
import { createSpacetimeClient } from './spacetimedb';

async function post(path: string, body?: unknown) {
  const response = await fetch(`/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || `Request failed (${response.status})`);
  }
}

export function createLocalClient(): WorldClient {
  return {
    subscribe(listener, onError) {
      let closed = false;
      let receivedEvent = false;
      const stream = new EventSource('/api/events');
      const receive = (event: MessageEvent) => {
        try { if (!closed) { receivedEvent = true; listener(JSON.parse(event.data) as WorldSnapshot); } }
        catch { onError?.('The database returned an invalid snapshot.'); }
      };
      stream.onmessage = receive;
      stream.addEventListener('world', receive as EventListener);
      stream.addEventListener('snapshot', receive as EventListener);
      stream.onerror = () => onError?.('Reconnecting to the local database…');
      fetch('/api/world').then(async response => {
        if (!response.ok) throw new Error('Start the local server to connect.');
        const world = await response.json() as WorldSnapshot;
        if (!closed && !receivedEvent) listener(world);
      }).catch(error => { if (!closed && !receivedEvent) onError?.(error.message); });
      return () => { closed = true; stream.close(); };
    },
    inject: () => post('/incidents/inject'),
    start: (pace = 'normal') => post('/demo/start', { pace }),
    stopAgents: () => post('/agents/stop'),
    reset: () => post('/demo/reset'),
    runAgent: (id: AgentId) => post(`/agents/${id}/run`),
  };
}

export function createWorldClient(): WorldClient {
  return import.meta.env.VITE_DATA_MODE === 'spacetimedb' ? createSpacetimeClient() : createLocalClient();
}
