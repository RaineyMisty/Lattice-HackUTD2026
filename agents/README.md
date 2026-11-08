# Lattice Repository Explorer

The Explorer accepts a repository already present on disk. Each worker starts a separate Codex CLI session, uses the exploration Skill to inspect source, and resumes its own session across tasks. Agents share discoveries and claims through the database interface.

## Run

Use Node.js 22.12 or later, installed workspace dependencies, and a current Codex CLI. For the OpenAI provider, authenticate with `codex login` or provide `OPENAI_API_KEY` in the launching process environment. On Windows, the Explorer automatically finds the CLI installed with `npm.cmd install -g @openai/codex`. Use `--codex-path` for a custom executable.

From the repository root:

```powershell
node --import tsx agents/src/explore-cli.ts C:\path\to\local-repo --agents 4 --seed 42 --turns 4
```

Ctrl+C cancels active turns. The seed determines initial file order and per-worker exploration preferences. It does not seed the model's sampling. When the repository has fewer eligible files than workers, starts can share a file with different questions.

## Use NVIDIA Nemotron

Get a key for [Nemotron 3.5 Super VL on NVIDIA Build](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b). From the repository root in PowerShell:

```powershell
$env:NVIDIA_API_KEY = [Net.NetworkCredential]::new('', (Read-Host -Prompt 'NVIDIA API key' -AsSecureString)).Password
node --import tsx agents/src/explore-cli.ts "C:\path\to\local-repo" --provider nvidia --agents 1 --turns 1
```

The NVIDIA preset uses `nvidia/nemotron-3.5-super-vl-120b-a12b` and sends Codex Responses requests to `https://integrate.api.nvidia.com/v1/responses`. It uses only the NVIDIA key and fails at startup if that key is missing. The default provider remains OpenAI. For library use, pass `new CodexHarness({ provider: 'nvidia' })` to `AgentManager`.

## Call from another module

```ts
import { AgentManager } from '@lattice/agents';

const manager = new AgentManager();
const run = await manager.start({ repositoryPath, agentCount: 4, seed: 42 });
const current = manager.getStatus(run.id);
const result = await run.done;
const discoveries = await manager.getContext(run.id);
// To stop an active run, call await manager.stop(run.id) or await run.stop().
```

The default adapter is in memory. `maxTurnsPerAgent` and `turnTimeoutMs` bound each worker. A completed run can still have pending tasks if its turn budget was exhausted. The harness only requests read-only tool access. The Explorer checks each cited quote against the specified local file and lines before committing it. A `source-matched` record confirms the citation, while interpretation of the relationship remains the agent's claim.

## Connect SpacetimeDB

Install the generated SDK's dependencies with `npm.cmd --prefix spacetime_db ci`. Start and publish the local module as shown in the root README. Use a clean Git checkout and the same CLI identity that owns the database.

```powershell
node --import tsx agents/src/explore-cli.ts ".\repo\train-ticket" --world train-ticket --create-world --provider nvidia --agents 4 --turns 2
```

`--create-world` creates a missing world using the local checkout's actual commit. Omit it to require an existing world. The checkout must match the world's commit. Use a new world ID for a new revision. The default destination is the local database in `spacetime_db/connection.json`. `--maincloud` selects the deployed Maincloud database. `--db-url` and `--database` can override either endpoint explicitly.

The owner authorizes a separate database identity for each Explorer. To run an already authorized Agent identity, set `LATTICE_STDB_TOKEN` and use `--agents 1`. The token is used by the database adapter. Without that variable the CLI reads its saved SpacetimeDB login. Configure your model provider independently.

The first run enqueues tracked source files if Frontier is empty. Each Explorer waits for subscription updates, claims a task through a reducer, reads current shared knowledge and the pinned source, then submits its verified entities, relations, executable behaviors, citations and follow-up tasks. The submission completes the claimed attempt in the same transaction. Failed or interrupted turns leave their lease for the database scheduler to retry. With `--turns`, each worker exits at its turn budget or when shared work drains. Without it, live workers wait for new tasks until Ctrl+C.

For SDK callers, pass `new SpacetimeExplorationDatabase({ uri, database, worldId, token })` to `AgentManager`. The live graph is in `(await manager.getContext(run.id)).world`. Calls without `--world` retain the standalone in-memory mode.

## Verify the live loop

Publish the module as `lattice-agent-loop-test` to an isolated local instance on port 3381, supply its publisher token via `LATTICE_STDB_TEST_TOKEN`, and run `node --import tsx --test agents/src/world.test.ts`. This test uses a temporary Git repository and a scripted Harness, and exercises a real SpacetimeDB server without making model requests.
