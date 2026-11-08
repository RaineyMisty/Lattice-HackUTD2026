import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentManager, CodexHarness, SpacetimeExplorationDatabase } from './index.ts';
import deployment from '../../spacetime_db/connection.json';

function databaseToken() {
  if (process.env.LATTICE_STDB_TOKEN) return process.env.LATTICE_STDB_TOKEN;
  const installed = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
  const cli = process.env.SPACETIME_CLI ?? (installed && existsSync(installed) ? installed : 'spacetime');
  const args = process.env.SPACETIME_ROOT ? ['--root-dir', process.env.SPACETIME_ROOT] : [];
  const login = spawnSync(cli, [...args, 'login', 'show', '--token'], { encoding: 'utf8', windowsHide: true });
  const token = login.stdout?.match(/eyJ[A-Za-z0-9_.-]+/)?.[0];
  if (login.status !== 0 || !token) throw new Error('Log in to SpacetimeDB or set LATTICE_STDB_TOKEN before running live Agents');
  return token;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agents: { type: 'string' }, seed: { type: 'string' }, turns: { type: 'string' },
    'codex-path': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' },
    world: { type: 'string' }, 'create-world': { type: 'boolean' }, maincloud: { type: 'boolean' },
    'db-url': { type: 'string' }, database: { type: 'string' },
  },
});
const usage = 'Usage: node --import tsx agents/src/explore-cli.ts <repository-path> [--world <id> [--create-world] [--maincloud] [--db-url <url>] [--database <name>]] [--provider openai|nvidia] [--agents 4] [--seed 42] [--turns <per-agent>] [--codex-path <exe>]';
if (values.help || positionals.length !== 1) {
  console.log(usage);
  process.exitCode = values.help ? 0 : 2;
} else {
  const count = (value: string | undefined) => value === undefined ? undefined : Number(value);
  try {
    const provider = values.provider ?? 'openai';
    if (provider !== 'openai' && provider !== 'nvidia') throw new Error('--provider must be openai or nvidia');
    if (!values.world && (values['create-world'] || values.maincloud || values['db-url'] || values.database)) {
      throw new Error('Use --world <id> to connect to SpacetimeDB');
    }
    const target = values.maincloud ? deployment.maincloud : deployment.local;
    const database = values.world ? new SpacetimeExplorationDatabase({
      uri: values['db-url'] ?? target.uri, database: values.database ?? target.database,
      worldId: values.world, createWorld: values['create-world'], token: databaseToken(),
    }) : undefined;
    const manager = new AgentManager({
      database,
      harness: new CodexHarness({
        provider,
        apiKey: provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.NVIDIA_API_KEY,
        codexPath: values['codex-path'] ?? process.env.LATTICE_CODEX_PATH,
        model: values.model,
      }),
    });
    const run = await manager.start({
      repositoryPath: positionals[0], agentCount: count(values.agents),
      seed: count(values.seed), maxTurnsPerAgent: count(values.turns),
    });
    const stop = () => { void run.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(JSON.stringify({ runId: run.id, phase: 'running', world: values.world, commit: run.getStatus().commit, agents: run.getStatus().agents.length }));
    try {
      const result = await run.done;
      const { nodes, edges, evidence, tasks, world, activity } = await manager.getContext(run.id);
      const counts = world ? {
        entities: world.entities.length, relations: world.relations.length, behaviors: world.behaviors.length,
        evidence: world.evidence.length, queuedTasks: world.frontier.filter(task => task.status === 'queued').length,
      } : { nodes: nodes.length, edges: edges.length, evidence: evidence.length, tasks: tasks.length };
      const recent = activity.filter(row => row.kind === 'verification').slice(-8).map(row => `${row.agentId}: ${row.message}`);
      console.log(JSON.stringify({ phase: result.phase, ...counts, agents: result.agents, recent }, null, 2));
      if (result.phase === 'failed') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
