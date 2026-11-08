# Lattice

Lattice displays a repository dependency world and simulates the impact of a fault. The React frontend uses the SDK in `spacetime_db/client` to subscribe to entities, relations, simulations, and exploration tasks. Its four Agent cards reflect task activity from the database.

## Run the interactive train-ticket demo

Use a clean Git checkout at `repo/train-ticket`, installed project dependencies, and an NVIDIA API key. Install the module dependencies with `npm.cmd --prefix spacetime_db ci` if needed. Sign in to SpacetimeDB CLI once with `spacetime login`.

From the project root in PowerShell:

```powershell
$env:NVIDIA_API_KEY = 'your NVIDIA key'
npm.cmd run dev
```

The dev server starts its own local SpacetimeDB instance on port 3382 and opens the page on an available port starting at 5173. The repository picker automatically discovers Git checkouts directly under `repo/` while the dev server is running. Each checkout starts in its own world, and Start becomes available when the working tree matches the selected commit. Train-ticket is selected by default when it is ready.

**Start** creates a simulation for the selected repository and starts its four Explorers. Verified findings grow the map and appear in the Agent speech bubbles. Use the bug icon to inject a fault, or pick up the wrench and click the red fault origin to remove its impact and cancel its pending events. Already executed behavior state stays in the simulation history. **Reset** stops the selected simulation and its active exploration, keeping discoveries in the database.

The four Explorers share one Harness and claim work independently using separate SpacetimeDB identities. Explorers keep claiming tasks until Reset or shutdown. When the Frontier drains, the runner schedules another batch of unexplored source files and waits once those files are exhausted. Each starts from one seeded Git-tracked file. The model uses read-only tools to inspect the repository, choose where to explore, and queue follow-up files. Discoveries are checked against the selected commit before submission. The private browser link is saved at `.data/interactive-demo/browser-url.txt` if you need to reopen it. Ctrl+C closes the demo processes. Model requests use the NVIDIA key in the terminal and call NVIDIA directly. Agents publish small batches during exploration, and the terminal reports each write as it happens.

The terminal shows each Explorer’s task, tool calls, and publication receipts. Temporary provider errors retry. A task is completed only after the model explicitly finishes it.

## Agent layout

- `agents/harness/` runs the NVIDIA tool loop, Git source tools, and workers.
- `agents/skill/` describes how to explore, cite source, and submit discoveries.
- `agents/spacetimedb/` handles subscriptions, leases, and discovery writes through generated bindings.

Deployments used by the standalone Agent CLI need the current database module for immediate task release. The interactive dev command publishes the local module automatically.

## Run against a local repository world

Use Node.js 22.12+ and SpacetimeDB CLI 2.14.1. Run the commands from the repository root in PowerShell. If the database module dependencies are missing, run `npm.cmd --prefix spacetime_db ci`.

Start SpacetimeDB in a separate terminal.

```powershell
spacetime start --listen-addr 127.0.0.1:3380 --data-dir .data/living-world
```

Publish with your CLI identity if the module is new.

```powershell
spacetime publish lattice-world-local --server http://127.0.0.1:3380 --module-path spacetime_db
```

In an Agent terminal with `NVIDIA_API_KEY` set, explore a clean local Git checkout. The first run creates a world pinned to the actual commit. Explorers run until stopped.

```powershell
npm.cmd run agent -- ".\repo\train-ticket" --world train-ticket --create-world --agents 4
```

Once the Agent CLI prints the running status, configure browser access in a frontend terminal.

```powershell
$env:LATTICE_WORLD_ID = 'train-ticket'
npm.cmd run setup:local
npm.cmd run dev -- --existing-world
```

Open the private operator URL in `.data/repository-operator-url.txt`. Once discovery rows are available, click **Start**, pick up the bug icon, and drop it on a service. The database highlights the fault and its potential impact. **Reset** stops that simulation.

If port 5173 is in use, set `$env:LATTICE_WEB_PORT = '5174'` before running local setup and Vite.

## Connect to a live repository

Use `npm.cmd run dev -- --existing-world` to view an already provisioned world. Without local setup, this mode uses the Maincloud deployment from `spacetime_db/connection.json`. Override it with `VITE_LATTICE_DB_URL`, `VITE_LATTICE_DATABASE`, and `VITE_LATTICE_WORLD_ID`. A `?world=<id>` URL selects a repository explicitly.

The publisher creates the world and uses `setMember` to grant the browser identity reader or operator access. When access is required, the page logs the browser identity to the developer console. The map starts empty and draws the selected world's subscribed entities and relations as they arrive.

The Agent CLI requires a repository world. See [database APIs](spacetime_db/README.md) for simulation and permissions.
