# Agent runtime and integration

The four agents have one job: read their assigned source from the database, extract its facts, and submit evidence. They do not import the domain rule engine, read another agent's output, decide risk, or create tasks. There is no agent-to-agent transport.

| Agent | Database source | Submitted facts |
| --- | --- | --- |
| A — Vulnerability Analyst | `source-advisory` | Component, affected version range, fixed version, severity |
| B — Dependency Analyst | `source-dependencies` | Service and component dependency edges |
| C — Deployment Analyst | `source-deployments` | Actual component versions in production |
| D — Ownership Analyst | `source-ownership` | Departments, owners, business importance |

`packages/agents/src/runner.ts` is the common execution lifecycle. Each run receives a distinct `AgentDatabase` instance, role, extractor, and cancellation signal. The local coordinator starts four independent runners in one Node process for convenience; each runner communicates with the database simulator through HTTP. The standalone CLI can instead run each role in a separate process. Neither arrangement requires direct communication between agents.

## Local demo

The native Node server listens on `127.0.0.1:4318`. It is a **local reducer simulator**, not a SpacetimeDB connection. It invokes the same domain functions used by the real SpacetimeDB module. Every committed snapshot is written atomically to `.data/world.json` before it is sent over SSE. Stopping agents leaves the world, evidence, tasks, and inbox records intact. Restarting the server reloads them.

The default `fixture` extractor parses structured source documents already in the database. It makes no network model call. The supplied fixture documents and vulnerability are fictional.

| Operator endpoint | Behavior |
| --- | --- |
| `GET /api/world` | Read a complete persisted snapshot |
| `GET /api/events` | SSE `world` event, initial snapshot and committed updates |
| `POST /api/incidents/inject` | Inject the fictional advisory once |
| `POST /api/demo/start` with `{ "pace": "normal" }` | Run all four agents; C submits last after about 34 seconds |
| `POST /api/demo/start` with `{ "pace": "fast" }` | Run the same investigation in about 6 seconds |
| `POST /api/agents/A/run` | Run one selected role; replace A with B, C or D |
| `POST /api/agents/stop` | Abort workers, invalidate stale writes, retain database state |
| `POST /api/demo/reset` | Clear this single fictional incident and reinitialize sources |

The simulator is loopback-only, and browser origins must also be loopback. Operator endpoints intentionally have no login: they are for a local hackathon demonstration. **This is not an authorization boundary for a remotely hosted application.** Authenticated agent tokens are rejected on all operator and world-reader endpoints. The real module uses SpacetimeDB identities and private source views; see `database.md`.

## Independent processes

Set matching role tokens before starting the server, then inject the incident through the UI. In each agent terminal load the same role's token and run:

```powershell
$env:LATTICE_AGENT_A_TOKEN = 'your-local-agent-a-token'
pnpm agent A
```

Use `LATTICE_AGENT_B_TOKEN`, `LATTICE_AGENT_C_TOKEN`, and `LATTICE_AGENT_D_TOKEN` for the other terminals. Each token grants only the matching role. If tokens are not configured, the coordinator creates random in-memory tokens and still runs all four agents automatically. Tokens are never sent to the browser.

The HTTP adapter first reads its role-scoped source and a run generation. Subsequent evidence/status writes include that generation. Stop/reset increments it before canceling workers, so a delayed model response cannot write into the next incident. Evidence validation and deduplication are performed by the database rule layer.

## Connect an actual extraction API

Set server-side environment values (never use a `VITE_` prefix for credentials):

```dotenv
LATTICE_AGENT_PROVIDER=model
LATTICE_MODEL_BASE_URL=https://your-provider.example/v1
LATTICE_MODEL=your-model-name
LATTICE_MODEL_API_KEY=your-private-api-key
```

`packages/agents/src/provider.ts` contains an OpenAI-compatible `/chat/completions` adapter. Its request uses JSON-object output and sends only the assigned raw source. Provider output is still untrusted: the reducer validates evidence kind, schema, role, source and accepted facts. Missing configuration, HTTP errors, malformed JSON or incorrect output are shown as agent errors; model mode never silently substitutes fixture output. Requests time out after 45 seconds and share the runner's abort signal.

For a different provider, implement `EvidenceExtractor.extract(agentId, source, signal)` and supply that implementation to the runtime. It returns `EvidencePayload`; it cannot return risk or task objects.

## Connect SpacetimeDB

`packages/agents/src/spacetimedb-database.ts` is the integration seam. After publishing the module and generating TypeScript bindings, implement `SpacetimeAgentPort` with one connection identity per agent:

1. Subscribe to the current identity's `my_sources` view. The backing `raw_source` table is private.
2. Map `readAssignedSources()` to that view's current rows, preserving the numeric `epoch` on each source. Wait for subscription application first.
3. Map `submitEvidence(sourceId, payloadJson, expectedEpoch)` to `conn.reducers.submitEvidence({ sourceId, payloadJson, expectedEpoch })`.
4. Map `updateStatus(status, message, expectedEpoch)` to `conn.reducers.updateAgentStatus({ status, message, expectedEpoch })`.
5. Instantiate `SpacetimeAgentDatabase('A', port)` and pass it to `runAgent`; repeat independently for B/C/D.

Do not give agents the operator identity or a reducer that writes derived tables. The reducer transaction performs risk derivation and notification generation, and the UI subscribes to the resulting rows. The local HTTP simulator and the generated-client adapter are intentionally distinct, so selecting live mode cannot masquerade as a connected database.

Create a new `SpacetimeAgentDatabase` instance for each run. It captures the first source epoch and never changes that epoch; all writes must match the database's current epoch. Stop/reset/resume invalidate old work, so an in-flight model response from an earlier run cannot repopulate a reset incident.

## Environment reference

| Variable | Default / purpose |
| --- | --- |
| `LATTICE_PORT` | `4318` |
| `LATTICE_DATA_DIR` | `.data`, relative to repository root |
| `LATTICE_SERVER_URL` | `http://127.0.0.1:4318` for the standalone CLI |
| `LATTICE_AGENT_PROVIDER` | `fixture`; use `model` to enable API extraction |
| `LATTICE_AGENT_A_TOKEN` … `LATTICE_AGENT_D_TOKEN` | Optional fixed local role tokens |
| `LATTICE_MODEL_BASE_URL` | Model provider base URL ending in `/v1` |
| `LATTICE_MODEL` | Provider model name |
| `LATTICE_MODEL_API_KEY` | Server-only secret |

The CLI and server load the repository root `.env` if present; shell environment values take precedence. Run `pnpm test` for role boundaries, extraction-only behavior, SSE subscriptions, stale-writer cancellation, idempotent task generation and restart persistence. Domain tests also exercise all agent submission orders.
