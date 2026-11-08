import { parseArgs } from 'node:util';
import deployment from '../../spacetime_db/connection.json';
import { publisherToken } from '../../scripts/local-world.ts';
import { printActivity, startExploration } from './run.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    world: { type: 'string' }, 'create-world': { type: 'boolean' }, maincloud: { type: 'boolean' },
    'db-url': { type: 'string' }, database: { type: 'string' }, agents: { type: 'string' }, seed: { type: 'string' }, help: { type: 'boolean' },
  },
});
if (values.help || positionals.length !== 1 || !values.world) {
  console.log('Usage: npm run agent -- <repository-path> --world <id> [--create-world] [--agents 4] [--seed 42] [--db-url <url>] [--database <name>] [--maincloud]');
  process.exitCode = values.help ? 0 : 2;
} else {
  try {
    const target = values.maincloud ? deployment.maincloud : deployment.local;
    const run = await startExploration({
      repositoryPath: positionals[0], agents: values.agents === undefined ? undefined : Number(values.agents),
      seed: values.seed === undefined ? undefined : Number(values.seed), onActivity: printActivity,
      world: {
        uri: values['db-url'] ?? target.uri, database: values.database ?? target.database,
        worldId: values.world, createWorld: values['create-world'],
        token: process.env.LATTICE_STDB_TOKEN || publisherToken(),
      },
    });
    const stop = () => { void run.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      console.log('Exploring ' + values.world + ' at ' + run.commit + '. Ctrl+C to stop.');
      const result = await run.done;
      console.log(result);
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
