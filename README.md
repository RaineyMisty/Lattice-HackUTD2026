# Lattice

Lattice displays a repository dependency world and simulates the impact of a fault. The React frontend uses the SDK in `spacetime_db/client` to subscribe to entities, relations, simulations, and exploration tasks. Its four Agent cards reflect task activity from the database.

## Run the interactive train-ticket demo

Use a clean Git checkout at `repo/train-ticket`, installed project dependencies, and a current Codex CLI. Install the module dependencies with `npm.cmd --prefix spacetime_db ci` if needed. Sign in to SpacetimeDB CLI once with `spacetime login`.

From the project root in PowerShell:

```powershell
$env:NVIDIA_API_KEY = 'your NVIDIA key'
npm.cmd run dev
```

The dev server starts its own local SpacetimeDB instance on port 3382 and opens the page on an available port starting at 5173. The repository picker lists clean Git checkouts directly under `repo/`, with train-ticket selected by default when present. Each checkout starts in its own world. Restart the dev server after adding a checkout to the directory.

**Start** creates a simulation for the selected repository and starts its four Explorers. Verified findings grow the map and appear in the Agent speech bubbles. Use the bug icon to inject a fault, or pick up the wrench and click the red fault origin to remove its impact and cancel its pending events. Already executed behavior state stays in the simulation history. **Reset** stops the selected simulation and its active exploration, keeping discoveries in the database.

The four Explorers share one implementation and choose distinct initial paths using their seeds. By default each Explorer can process 16 tasks. They verify the Git-tracked Spring Boot entries and explicit HTTP call sites first, then use the model for implementation follow-ups. Set `LATTICE_DEMO_TURNS` before launch to change the task budget per Explorer. The private browser link is saved at `.data/interactive-demo/browser-url.txt` if you need to reopen it. Ctrl+C closes the demo processes. Model requests use the NVIDIA key in the terminal.

The terminal shows each Explorer's task, model progress, verified or skipped candidates, and database commits. A pending line every ten seconds identifies the current stage. A directory proposed as a follow-up is skipped. When a model returns no graph facts for a recognized Spring Boot entry, the Explorer can verify the service and an implementation follow-up from the pinned source and Maven manifest.

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

In an Agent terminal with `NVIDIA_API_KEY` set, explore a clean local Git checkout. The first run creates a world at the actual commit. The example limits each Explorer to two turns.

```powershell
node --import tsx agents/src/explore-cli.ts ".\repo\train-ticket" --world train-ticket --create-world --provider nvidia --agents 4 --turns 2
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

The Agent CLI subscribes and writes to SpacetimeDB when given `--world`. Without that option it runs an in-memory exploration. See [Agent usage](agents/README.md) for connection options and [database APIs](spacetime_db/README.md) for simulation and permissions.
