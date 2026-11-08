# Lattice

A fictional TokenGate incident exercise for ASTER Commerce.

| Module | Responsibility |
| --- | --- |
| `frontend/` | React UI. Calls Start and Reset reducers and subscribes to the operator view through generated bindings. |
| `agents/` | One runner with four independent role processes. Each subscribes to its assigned source and submits evidence and progress. |
| `db/` | SpacetimeDB reducers, inference rules, access control, durable state, tasks, and notifications. `db/client/` contains generated TypeScript bindings. |

`shared/types/` contains type definitions. All impact classifications and inbox records come from the database.

## Run locally

Use Node.js 22.12+ and SpacetimeDB CLI 2.13.0. Install project dependencies with `pnpm install --frozen-lockfile` if needed. The launch commands below use Node directly.

Start a disk-backed SpacetimeDB instance in its own terminal.

```powershell
spacetime start --listen-addr 127.0.0.1:3000
```

From the repository root, publish with your local publishing identity and register one operator plus four Agent identities.

```powershell
spacetime publish --server http://127.0.0.1:3000 --module-path db lattice-demo
node --import tsx scripts/setup-local.ts
```

Setup stores per-role tokens under the ignored `.data/` directory. Open the operator URL saved in `.data/operator-url.txt` in the browser after starting the frontend. The URL grants operator access to this local demo and should be kept private.

Start each Agent command in its own terminal. For a slower recording, set `$env:LATTICE_AGENT_DELAY_MS = '1500'` in each Agent terminal before launching. The default fixture extractor reads the database-assigned fictional document.

```powershell
node --import tsx agents/src/cli.ts A
node --import tsx agents/src/cli.ts B
node --import tsx agents/src/cli.ts C
node --import tsx agents/src/cli.ts D
```

```powershell
node scripts/dev.mjs
```

Open the operator URL and click **Start Investigation**. The Agent cards update as workers report progress. The graph and inbox update on committed database events. Stop the worker terminals and reload to see the same persisted results. **Reset** clears the incident and revokes unfinished work. Workers that remain connected will pick up the next incident.

Set `LATTICE_DB_URL` and `LATTICE_DATABASE` for a different local deployment. Agent processes can take their own `LATTICE_AGENT_<role>_TOKEN` from the environment. See `.env.example` for optional model settings. The browser uses `VITE_LATTICE_DB_URL` and `VITE_LATTICE_DATABASE`; the development script loads them from the local setup config.

## Verify

```powershell
node scripts/test.mjs
node --import tsx --test db/test/live.test.ts
```

The first command runs the existing domain, runner, and reducer suites. The live test resets the configured incident, launches four Node processes, verifies the actual subscriptions and persisted rows, and checks access and stale-write rejection. Configure a dedicated test database before running it.

Regenerate client bindings after a schema or reducer signature change.

```powershell
spacetime generate --lang typescript --module-path db --out-dir db/client
```
