import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExplorationWorld, type AgentConnection, type Claim, type WorldOptions } from '../spacetimedb/client.ts';
import { ModelConfigurationError, nvidiaModel, type Message, type Model } from './model.ts';
import { Repository } from './repository.ts';
import { explorationTools, tools } from './tools.ts';

export interface Activity { agent: string; message: string }
export function printActivity({ agent, message }: Activity) {
  const safe = message.replace(/(?:nvapi|sk)-[\w-]+|eyJ[A-Za-z0-9_.-]+/g, '[redacted]').replace(/[\x00-\x1f]+/g, ' ');
  console.log('[' + new Date().toLocaleTimeString() + '] [' + agent + '] ' + safe.slice(0, 400));
}

interface ExplorationOptions {
  repositoryPath: string;
  world: WorldOptions;
  model?: Model;
  agents?: number;
  seed?: number;
  onActivity?: (activity: Activity) => void;
}
const taskTimeoutMs = 150_000;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

async function investigate(model: Model, skill: string, repo: Repository, db: AgentConnection, claim: Claim,
  signal: AbortSignal, log: (message: string) => void) {
  const session = explorationTools(repo, db, claim, signal, log);
  const preview = await session.read(claim.path, 1).catch(error => {
    signal.throwIfAborted();
    return { error: reason(error) };
  });
  const messages: Message[] = [
    { role: 'system', content: skill },
    { role: 'user', content: JSON.stringify({ path: claim.path, question: claim.question, commit: repo.commit, preview }) },
  ];
  let missed = 0;
  let rejected = 0;
  while (true) {
    const reply = await model.next(messages, tools, signal, log);
    signal.throwIfAborted();
    const calls = reply.message.tool_calls ?? [];
    if (reply.truncated || !calls.length) {
      if (++missed >= 3) throw new Error('Model did not return a complete tool call');
      messages.push({ role: 'user', content: 'Return one small tool call. Use publish_discovery for ready facts, or finish_task with an outcome when done.' });
      continue;
    }
    missed = 0;
    messages.push(reply.message);
    for (const call of calls) {
      signal.throwIfAborted();
      const name = call.function.name;
      log(name);
      let reply: Awaited<ReturnType<typeof session.call>>;
      try {
        reply = await session.call(name, call.function.arguments);
      } catch (error) {
        signal.throwIfAborted();
        const message = reason(error).slice(0, 240);
        log(name + ' rejected — ' + message);
        reply = { result: { error: message }, failed: true };
      }
      rejected = reply.failed ? rejected + 1 : 0;
      if (rejected >= 3) throw new Error('Three consecutive tool rejections; retrying the task with fresh context');
      if (reply.finished) {
        await db.finish(claim);
        log(reply.finished);
        return;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(reply.result) });
    }
  }
}

export async function startExploration(options: ExplorationOptions) {
  const count = options.agents ?? 4;
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Agent count must be between 1 and 32');
  const model = options.model ?? nvidiaModel();
  const [repo, skill] = await Promise.all([
    Repository.open(options.repositoryPath),
    readFile(new URL('../skill/SKILL.md', import.meta.url), 'utf8'),
  ]);
  const seed = options.seed ?? randomBytes(4).readUInt32LE();
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Seed must be an unsigned 32-bit integer');
  const candidates = repo.candidates(seed);
  if (!candidates.length) throw new Error('No readable Git source paths were found');
  const world = await ExplorationWorld.open(options.world, basename(repo.root), repo.commit, count);
  try {
    if (!world.control.frontier().some(task => task.status === 'queued' || task.status === 'leased')) {
      await world.replenish(candidates, count);
    }
  } catch (error) {
    world.close();
    throw error;
  }

  const controller = new AbortController();
  const { signal } = controller;
  let refill: Promise<void> | undefined;
  let failed = false;
  const workers = world.agents.map(async (db, index) => {
    const agent = 'agent-' + (index + 1);
    const log = (message: string) => options.onActivity?.({ agent, message });
    let preferred: string | undefined = candidates[index];
    let waiting = false;
    try {
      while (!signal.aborted) {
        const revision = db.frontierRevision;
        const claim = await db.claim(signal, taskTimeoutMs + 15_000, preferred);
        preferred = undefined;
        if (!claim) {
          const frontier = db.frontier();
          if (!frontier.some(row => row.status === 'queued' || row.status === 'leased')) {
            await (refill ??= world.replenish(candidates, count, db).finally(() => { refill = undefined; }));
          }
          if (!waiting) log('Waiting for Frontier work');
          waiting = true;
          await db.wait(revision, signal);
          continue;
        }

        waiting = false;
        log('Claimed ' + claim.path);
        const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(taskTimeoutMs)]);
        const started = Date.now();
        const heartbeat = setInterval(() => log('Still exploring ' + claim.path + ' (' + Math.round((Date.now() - started) / 1000) + 's)'), 15_000);
        heartbeat.unref();
        try {
          await investigate(model, skill, repo, db, claim, turnSignal, log);
        } catch (error) {
          const permanent = error instanceof ModelConfigurationError;
          await db.release(claim, !signal.aborted && !permanent).catch(releaseError => log('Lease release failed — ' + reason(releaseError)));
          if (permanent) throw error;
          if (signal.aborted) break;
          log('Released for retry — ' + reason(error));
          await delay(750, undefined, { signal });
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        failed = true;
        log('Explorer stopped — ' + reason(error));
        if (error instanceof ModelConfigurationError) controller.abort(error);
      }
    }
  });
  const done = Promise.all(workers).then(() => {
    const summary = world.summary();
    world.close();
    return { phase: failed ? 'failed' as const : 'stopped' as const, ...summary };
  });
  return {
    done,
    commit: repo.commit,
    stop() {
      controller.abort(new Error('Exploration stopped'));
      return done;
    },
  };
}

export type Exploration = Awaited<ReturnType<typeof startExploration>>;
