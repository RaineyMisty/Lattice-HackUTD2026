import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AGENT_SOURCE, type AgentId, type AgentState, type EvidencePayload, type WorldSnapshot } from '../../../packages/contracts/src/index.js';
import { createInitialWorld, injectIncident, submitEvidence } from '../../../packages/domain/src/index.js';
import { HttpAgentDatabase } from '../../../packages/agents/src/http-database.js';
import { createExtractor, type EvidenceExtractor } from '../../../packages/agents/src/provider.js';
import { runAgent } from '../../../packages/agents/src/runner.js';
import { PersistentWorld } from './store.js';

const IDS: AgentId[] = ['A', 'B', 'C', 'D'];
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 131_072) throw new HttpError(413, 'Request body exceeds 128 KB');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Expected a JSON object'); }
}
function systemEvent(world: WorldSnapshot, message: string): WorldSnapshot {
  return { ...world, events: [...world.events, { id: randomUUID(), at: new Date().toISOString(), type: 'system', message }] };
}

export interface DemoServerOptions {
  dataDirectory: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  extractor?: EvidenceExtractor;
}
export interface DemoServer { server: Server; url: string; store: PersistentWorld; close(): Promise<void>; }

export async function createDemoServer(options: DemoServerOptions): Promise<DemoServer> {
  const env = options.env ?? process.env;
  const store = await PersistentWorld.open(options.dataDirectory);
  const tokens = Object.fromEntries(IDS.map(id => [id, env[`LATTICE_AGENT_${id}_TOKEN`] ?? randomBytes(32).toString('hex')])) as Record<AgentId, string>;
  const running = new Map<AgentId, { controller: AbortController; promise: Promise<void> }>();
  const streams = new Set<ServerResponse>();
  let generation = 1;
  let url = '';
  let closing = false;
  let controlQueue: Promise<unknown> = Promise.resolve();
  const control = <T>(action: () => Promise<T>): Promise<T> => {
    const result = controlQueue.then(action);
    controlQueue = result.catch(() => undefined);
    return result;
  };
  const abortWorkers = () => {
    generation++;
    for (const { controller } of running.values()) controller.abort(new Error('Agent execution stopped'));
    running.clear();
  };
  const ensureGeneration = (requested: number) => {
    if (requested !== generation) throw new HttpError(409, 'This agent run was stopped or reset; read fresh sources before retrying');
  };
  const authorize = (req: IncomingMessage, id: AgentId) => {
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(tokens[id]);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, 'Agent identity is not authorized for this source');
  };
  const launch = (id: AgentId, pace: 'normal' | 'fast', extractor: EvidenceExtractor) => {
    if (running.has(id)) throw new HttpError(409, `Agent ${id} is already running`);
    const controller = new AbortController();
    const delays = pace === 'fast' ? { A: 500, B: 1400, C: 5300, D: 2500 } : { A: 6000, B: 12000, C: 29000, D: 19000 };
    const database = new HttpAgentDatabase({ baseUrl: url, agentId: id, token: tokens[id], signal: controller.signal });
    const promise = runAgent({ id, database, extractor, signal: controller.signal, readingMs: pace === 'fast' ? 400 : 5000, extractionMs: delays[id] })
      .catch(error => { if (!controller.signal.aborted) console.error(`[Agent ${id}] ${error instanceof Error ? error.message : 'Failed'}`); })
      .finally(() => { if (running.get(id)?.controller === controller) running.delete(id); });
    running.set(id, { controller, promise });
  };

  const server = createServer(async (req, res) => {
    try {
      if (closing) throw new HttpError(503, 'Local database is shutting down');
      const origin = req.headers.origin;
      if (origin) {
        let permitted = false;
        try { const parsed = new URL(origin); permitted = ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname); } catch { /* deny */ }
        if (!permitted) throw new HttpError(403, 'This local demo accepts requests from loopback origins only');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lattice-Generation' }); res.end(); return;
      }
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      // UI controls are loopback-only demo administration. An identified agent
      // may access only its scoped /sources, /status and /evidence endpoints.
      if (req.headers.authorization && !/^\/api\/agents\/[ABCD]\/(sources|evidence|status)$/.test(pathname)) {
        throw new HttpError(403, 'Agent credentials cannot access command-center administration or world tables');
      }
      if (req.method === 'GET' && pathname === '/api/health') { json(res, 200, { ok: true, mode: 'local', persistence: true }); return; }
      if (req.method === 'GET' && pathname === '/api/world') { json(res, 200, store.snapshot()); return; }
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const send = (world: WorldSnapshot) => { res.write(`id: ${world.revision}\nevent: world\ndata: ${JSON.stringify(world)}\n\n`); };
        streams.add(res);
        const unsubscribe = store.subscribe(send);
        send(store.snapshot());
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
        res.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
        return;
      }
      const agentRoute = pathname.match(/^\/api\/agents\/([ABCD])\/(sources|evidence|status|run)$/);
      if (agentRoute && agentRoute[2] !== 'run') {
        const id = agentRoute[1] as AgentId;
        authorize(req, id);
        if (!store.snapshot().incident) throw new HttpError(409, 'Inject the incident first');
        if (store.snapshot().agentsStopped) throw new HttpError(409, 'Agents are stopped; resume a run before submitting more evidence');
        if (agentRoute[2] === 'sources' && req.method === 'GET') {
          json(res, 200, { generation, sources: store.snapshot().sources.filter(source => source.kind === AGENT_SOURCE[id]) }); return;
        }
        if (req.method !== 'POST') throw new HttpError(405, 'Use POST for agent writes');
        const requestedGeneration = Number(req.headers['x-lattice-generation']);
        ensureGeneration(requestedGeneration);
        const body = await bodyOf(req);
        if (agentRoute[2] === 'evidence') {
          if (typeof body.sourceId !== 'string' || !body.payload) throw new HttpError(400, 'sourceId and payload are required');
          await store.transact(world => {
            ensureGeneration(requestedGeneration);
            return submitEvidence(world, id, body.sourceId as string, body.payload as EvidencePayload);
          });
        } else {
          if (!['reading', 'extracting', 'error', 'stopped'].includes(String(body.status)) || typeof body.message !== 'string') throw new HttpError(400, 'Invalid agent status');
          const status = body.status as AgentState['status'];
          const message = body.message.slice(0, 240);
          await store.transact(world => {
            ensureGeneration(requestedGeneration);
            const at = new Date().toISOString();
            return { ...world, agents: world.agents.map(agent => agent.id === id ? { ...agent, status, message, updatedAt: at } : agent),
              events: [...world.events, { id: randomUUID(), at, type: 'agent', message: `Agent ${id}: ${message}`, agentId: id }] };
          });
        }
        json(res, 200, { accepted: true, revision: store.snapshot().revision }); return;
      }
      if (req.method !== 'POST') throw new HttpError(404, 'Endpoint not found');
      const body = await bodyOf(req);
      if (pathname === '/api/incidents/inject') {
        await control(async () => {
          if (store.snapshot().incident) return;
          await store.transact(world => injectIncident(world));
        });
      } else if (pathname === '/api/demo/start') {
        if (body.pace !== undefined && !['normal', 'fast'].includes(String(body.pace))) throw new HttpError(400, 'pace must be normal or fast');
        await control(async () => {
          if (!store.snapshot().incident) throw new HttpError(409, 'Inject the incident first');
          if (running.size) throw new HttpError(409, 'An investigation is already running');
          const extractor = options.extractor ?? createExtractor(env);
          await store.transact(world => systemEvent({ ...world, agentsStopped: false, startedAt: new Date().toISOString() }, 'Four independent evidence agents started'));
          for (const id of IDS) launch(id, body.pace === 'fast' ? 'fast' : 'normal', extractor);
        });
      } else if (pathname === '/api/agents/stop') {
        await control(async () => {
          abortWorkers();
          await store.transact(world => systemEvent({ ...world, agentsStopped: true,
            agents: world.agents.map(agent => ({ ...agent, status: 'stopped', message: agent.evidenceCount ? 'Offline · submitted evidence persists' : 'Offline · no evidence submitted', updatedAt: new Date().toISOString() })) },
          'All agents stopped. Database state and department tasks remain queryable.'));
        });
      } else if (pathname === '/api/demo/reset') {
        await control(async () => { abortWorkers(); await store.transact(() => createInitialWorld()); });
      } else if (agentRoute?.[2] === 'run') {
        await control(async () => {
          const id = agentRoute[1] as AgentId;
          if (!store.snapshot().incident) throw new HttpError(409, 'Inject the incident first');
          if (running.has(id)) throw new HttpError(409, `Agent ${id} is already running`);
          const extractor = options.extractor ?? createExtractor(env);
          await store.transact(world => ({ ...world, agentsStopped: false, startedAt: world.startedAt ?? new Date().toISOString() }));
          launch(id, 'fast', extractor);
        });
      } else throw new HttpError(404, 'Endpoint not found');
      json(res, 200, { ok: true, revision: store.snapshot().revision });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'Request failed' });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server, url, store,
    async close() {
      if (closing) return;
      closing = true;
      await controlQueue;
      const pending = [...running.values()].map(worker => worker.promise);
      abortWorkers();
      await Promise.allSettled(pending);
      await store.flush();
      for (const stream of streams) stream.end();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
