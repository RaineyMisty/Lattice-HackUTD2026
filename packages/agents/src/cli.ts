import { HttpAgentDatabase } from './http-database.js';
import { createExtractor } from './provider.js';
import { runAgent } from './runner.js';
import type { AgentId } from '../../contracts/src/index.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './env.js';

loadProjectEnv(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const id = process.argv[2]?.toUpperCase() as AgentId;
if (!['A', 'B', 'C', 'D'].includes(id)) throw new Error('Usage: pnpm agent A (or B, C, D)');
const token = process.env[`LATTICE_AGENT_${id}_TOKEN`];
if (!token) throw new Error(`Set LATTICE_AGENT_${id}_TOKEN in both server and this process before starting`);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Agent stopped')));
process.once('SIGTERM', () => controller.abort(new Error('Agent stopped')));
const database = new HttpAgentDatabase({
  baseUrl: process.env.LATTICE_SERVER_URL ?? 'http://127.0.0.1:4318', agentId: id, token, signal: controller.signal,
});
await runAgent({ id, database, extractor: createExtractor(), signal: controller.signal });
if (!controller.signal.aborted) console.log(`Agent ${id}: evidence submitted. Database owns all risk and task decisions.`);
