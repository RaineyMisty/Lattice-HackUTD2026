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

Pass `new SpacetimeExplorationDatabase(bindings)` as the manager's `database`. The binding contract in `src/database/client.ts` exposes:

- A read view scoped by run for nodes, edges, evidence, tasks, status, and activity.
- Atomic task claims scoped by run, Agent, and session.
- Reducers to initialize a run, commit an idempotent discovery batch and complete its claim, release or fail a claim, and write status and logs.

Keep the run ID in all table keys or indexes. Enforce claim ownership at commit, and use a lease for abandoned remote claims. An edge can arrive before its endpoint nodes from a different worker, so the database can hold it until both endpoints exist. Bind the claim call to a procedure or to a reducer plus its correlated subscription result. Existing TokenGate tables are separate from this exploration schema.

`CodingHarness` is also injectable. The tests use a local harness fixture to exercise parallel tasks, evidence validation, and cancellation without a model request.
