import { parseArgs } from 'node:util';
import { AgentManager, CodexHarness } from './index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agents: { type: 'string' }, seed: { type: 'string' }, turns: { type: 'string' },
    'codex-path': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' },
  },
});
const usage = 'Usage: node --import tsx agents/src/explore-cli.ts <repository-path> [--provider openai|nvidia] [--agents 4] [--seed 42] [--turns 4] [--codex-path <exe>]';
if (values.help || positionals.length !== 1) {
  console.log(usage);
  process.exitCode = values.help ? 0 : 2;
} else {
  const count = (value: string | undefined) => value === undefined ? undefined : Number(value);
  try {
    const provider = values.provider ?? 'openai';
    if (provider !== 'openai' && provider !== 'nvidia') throw new Error('--provider must be openai or nvidia');
    const manager = new AgentManager({
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
    console.log(JSON.stringify({ runId: run.id, phase: 'running', agents: run.getStatus().agents.length }));
    try {
      const result = await run.done;
      const { nodes, edges, evidence, tasks } = await manager.getContext(run.id);
      console.log(JSON.stringify({ phase: result.phase, nodes: nodes.length, edges: edges.length, evidence: evidence.length, tasks: tasks.length, agents: result.agents }, null, 2));
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
