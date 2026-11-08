# Lattice

Lattice displays a repository dependency world and simulates the impact of a fault. The React frontend uses the SDK in `spacetime_db/client` to subscribe to entities, relations, simulations, and exploration tasks. Its four Agent cards reflect task activity from the database.

## Run against a local repository world

Use Node.js 22.12+ and SpacetimeDB CLI 2.14.1. Run the commands from the repository root in PowerShell. If the database module dependencies are missing, run `npm.cmd --prefix spacetime_db ci`.

Start SpacetimeDB in a separate terminal.

```powershell
spacetime start --listen-addr 127.0.0.1:3380 --data-dir .data/living-world
```

Publish with your CLI identity if the module is new. Create a world with the actual repository and commit through the database API, then pass its ID to the local setup. Setup grants a browser operator identity access to that existing world.

```powershell
spacetime publish lattice-world-local --server http://127.0.0.1:3380 --module-path spacetime_db
$env:LATTICE_WORLD_ID = '<existing-world-id>'
npm.cmd run setup:local
npm.cmd run dev
```

Open the private operator URL in `.data/repository-operator-url.txt`. Once discovery rows are available, click **Start**, pick up the bug icon, and drop it on a service. The database highlights the fault and its potential impact. **Reset** stops that simulation.

If port 5173 is in use, set `$env:LATTICE_WEB_PORT = '5174'` before running local setup and Vite.

## Connect to a live repository

Without local setup, Vite uses the Maincloud deployment from `spacetime_db/connection.json`. Override it with `VITE_LATTICE_DB_URL`, `VITE_LATTICE_DATABASE`, and optionally `VITE_LATTICE_WORLD_ID`. A `?world=<id>` URL selects a repository explicitly.

The publisher creates the world and uses `setMember` to grant the browser identity reader or operator access. When access is required, the page logs the browser identity to the developer console. The map starts empty and draws the selected world's subscribed entities and relations as they arrive.

The standalone Agent CLI currently keeps its exploration output in memory. The frontend displays Agent activity once an external worker claims tasks in this database. See `spacetime_db/README.md` for the Agent and database APIs.
