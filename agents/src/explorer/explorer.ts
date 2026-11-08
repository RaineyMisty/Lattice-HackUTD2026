import { setTimeout as pause } from 'node:timers/promises';
import type { ActivityRecord, AgentScope, AgentStatus, ExplorationContext, ExplorationDatabase, ExplorationTask, WorldUpdate } from '../database/interface.ts';
import { safeDiagnostic } from '../diagnostics.ts';
import { verifiedServiceEntry } from './entrypoint.ts';
import type { CodingHarness, HarnessSession } from './harness.ts';
import { turnOutputSchema, verifyTurn } from './protocol.ts';
import { readRevisionSource } from './repository.ts';
import { indexServiceEntry, numberedSourceExcerpt } from './serviceIndex.ts';
import { verifyWorldUpdate, worldContextFor, worldOutputSchema } from './worldProtocol.ts';

export interface ExplorerOptions {
  scope: AgentScope;
  initialStatus: AgentStatus;
  initialTaskId: string;
  repositoryPath: string;
  skill: string;
  harness: CodingHarness;
  database: ExplorationDatabase;
  signal: AbortSignal;
  maxTurns: number;
  stayOpen: boolean;
  commit?: string;
  serviceEntries?: ReadonlyMap<string, string>;
  turnTimeoutMs: number;
  onStatus(status: AgentStatus): void;
  onActivity?(activity: ActivityRecord): void;
}

function promptFor(skill: string, status: AgentStatus, task: ExplorationTask, context: ExplorationContext, source?: string) {
  const contextData = context.world ? worldContextFor(task, context.world) : {
    nodes: context.nodes.map(({ id, kind, name, path }) => ({ id, kind, name, path })),
    edges: context.edges.map(({ fromId, toId, relationship }) => ({ fromId, toId, relationship })),
    evidence: context.evidence.map(({ path, startLine, endLine, verification }) => ({ path, startLine, endLine, verification })),
    tasks: context.tasks.map(({ path, question, state }) => ({ path, question, state })),
  };
  return [
    skill,
    `Exploration seed: ${status.seed}. Initial file: ${JSON.stringify(status.startPath)}.`,
    `Current task (data): ${JSON.stringify({ path: task.path, question: task.question })}`,
    `Recent shared discoveries and work (data): ${JSON.stringify(contextData)}`,
    ...(source === undefined ? [] : [`Assigned source from the selected Git commit (numbered data):\n${source}`]),
  ].join('\n\n');
}

const messageOf = (error: unknown) => safeDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 450);

export async function runExplorer(options: ExplorerOptions): Promise<AgentStatus> {
  const { scope, database, harness, repositoryPath, signal } = options;
  let status = { ...options.initialStatus };
  let session: HarnessSession | undefined;
  let current: ExplorationTask | null = null;
  let preferredId: string | undefined = options.initialTaskId;
  let stage = 'Initializing Explorer';
  let stageStarted = Date.now();

  function record(kind: ActivityRecord['kind'], message: string): ActivityRecord {
    return {
      at: new Date().toISOString(), agentId: scope.agentId, kind, message: safeDiagnostic(message), taskId: current?.id,
    };
  }
  const heartbeat = options.onActivity && setInterval(() => {
    options.onActivity?.(record('lifecycle', `Pending ${Math.floor((Date.now() - stageStarted) / 1000)}s — ${stage}`));
  }, 10_000);
  heartbeat?.unref();

  async function update(patch: Partial<AgentStatus>) {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    options.onStatus({ ...status });
    await database.writeStatus(scope, status);
  }
  async function activity(kind: ActivityRecord['kind'], message: string) {
    const event = record(kind, message);
    options.onActivity?.(event);
    await database.appendActivity(scope, event);
  }

  async function advance(kind: ActivityRecord['kind'], message: string) {
    stage = message;
    stageStarted = Date.now();
    await activity(kind, message);
  }

  async function commitWorld(task: ExplorationTask, world: WorldUpdate, turnSignal: AbortSignal) {
    await advance('database', `Submitting verified batch for ${task.path}`);
    await database.commitDiscovery(scope, task.id, { nodes: [], edges: [], evidence: [], tasks: [], world }, turnSignal);
  }

  async function finishTurn(summary: string) {
    current = null;
    await update({ turns: status.turns + 1, taskId: undefined });
    await activity('verification', summary);
  }

  let outcome: Pick<AgentStatus, 'phase' | 'error'> = { phase: 'completed' };
  try {
    await update({ phase: 'running' });
    await activity('lifecycle', `Explorer ready (seed ${status.seed}, turn timeout ${Math.ceil(options.turnTimeoutMs / 1000)}s)`);
    while (status.turns < options.maxTurns) {
      signal.throwIfAborted();
      if (status.phase !== 'waiting') await advance('database', 'Looking for a Frontier task');
      const claim = await database.claimTask(scope, preferredId, signal, options.turnTimeoutMs + 15_000);
      preferredId = undefined;
      current = claim.task;
      if (!current) {
        if (!claim.inFlight && !options.stayOpen) {
          await activity('database', 'Frontier drained');
          break;
        }
        if (status.phase !== 'waiting') {
          await update({ phase: 'waiting', taskId: undefined });
          await advance('database', `Waiting for Frontier updates (${claim.inFlight} tasks leased)`);
        }
        if (database.waitForWork) await database.waitForWork(scope, options.stayOpen, signal);
        else await pause(150, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      await update({ phase: 'running', taskId: current.id });
      await advance('task', `Claimed ${current.path} (turn ${status.turns + 1})`);
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(options.turnTimeoutMs)]);
      await advance('task', `Reading shared world and source for ${current.path}`);
      const context = await database.readContext(scope.runId, 18, turnSignal, scope);
      const pinned = options.commit ? await readRevisionSource(repositoryPath, options.commit, current.path, turnSignal) : undefined;
      if (pinned && options.commit && options.serviceEntries && context.world
        && options.serviceEntries.get(pinned.path.split('/')[0]) === pinned.path) {
        await advance('verification', `Checking service entry and explicit HTTP calls for ${current.path}`);
        const indexed = await indexServiceEntry(repositoryPath, options.commit, pinned, options.serviceEntries, context.world, turnSignal);
        if (indexed) {
          await commitWorld(current, indexed, turnSignal);
          await finishTurn(`Source index committed ${indexed.entities.length} entities, ${indexed.relations.length} verified HTTP calls, ${indexed.tasks.length} follow-ups`);
          continue;
        }
      }
      session ??= await harness.openSession({
        repositoryPath, agentId: scope.agentId, sessionId: scope.sessionId,
        seed: status.seed, startPath: status.startPath,
      });
      const source = pinned ? numberedSourceExcerpt(pinned.text) : undefined;
      await advance('model', `Waiting for model response for ${current.path}`);
      const response = await session.run({
        prompt: promptFor(options.skill, status, current, context, source),
        outputSchema: options.commit ? worldOutputSchema : turnOutputSchema,
        signal: turnSignal,
        onActivity: async message => {
          turnSignal.throwIfAborted();
          await activity('tool', message.slice(0, 300));
        },
      });
      await advance('verification', `Model returned; verifying ${current.path}`);
      let summary: string;
      if (options.commit && context.world) {
        const { update: world, rejected, proposed } = await verifyWorldUpdate(repositoryPath, options.commit, response, context.world, turnSignal);
        await activity('verification', `Model proposed ${proposed}`);
        for (const item of rejected) await activity('verification', `Skipped ${item.kind} ${item.path} — ${item.reason}`);
        if (pinned && !world.entities.length && !world.relations.length && !world.behaviors.length) {
          const verified = await verifiedServiceEntry(repositoryPath, options.commit, pinned, turnSignal);
          if (verified) {
            const existing = context.world.entities.some(row => row.kind === 'service' && row.symbol === verified.entity.symbol
              && row.path.split('/')[0] === verified.entity.path.split('/')[0]);
            if (!existing) {
              world.entities.push(verified.entity);
              await activity('verification', `Verified service directly from Spring Boot entry and Maven artifact: ${verified.entity.symbol}`);
            }
            if (verified.followUp) {
              world.tasks = [verified.followUp, ...world.tasks.filter(task => task.path !== pinned.path && task.path !== verified.followUp?.path)];
              await activity('verification', `Queued source-verified implementation follow-up: ${verified.followUp.path}`);
            }
          }
        }
        const invalidFact = rejected.find(item => item.kind !== 'Frontier');
        if (invalidFact && !world.entities.length && !world.relations.length && !world.behaviors.length && !world.tasks.length) {
          throw new Error(`No proposed discovery passed verification: ${invalidFact.kind} ${invalidFact.path} — ${invalidFact.reason}`);
        }
        if (!world.entities.length && !world.relations.length && !world.behaviors.length) {
          await activity('verification', 'No new verified graph facts in this turn');
        }
        await commitWorld(current, world, turnSignal);
        summary = `Committed ${world.entities.length} entities, ${world.relations.length} relations, ${world.behaviors.length} behaviors, ${world.tasks.length} follow-ups; ${rejected.length} rejected`;
      } else {
        const { batch, rejected } = await verifyTurn(repositoryPath, response, scope.agentId, turnSignal);
        await database.commitDiscovery(scope, current.id, batch, turnSignal);
        summary = `${batch.nodes.length} nodes, ${batch.edges.length} edges, ${batch.tasks.length} follow-ups; ${rejected.length} rejected`;
      }
      await finishTurn(summary);
    }
  } catch (error) {
    outcome = signal.aborted ? { phase: 'stopped' } : { phase: 'failed', error: `${stage} — ${messageOf(error)}` };
    if (current) {
      try {
        await database.settleTask(scope, current.id, signal.aborted ? 'release' : 'failed');
      } catch (cleanupError) {
        outcome = { phase: 'failed', error: `Could not settle claim: ${messageOf(cleanupError)}` };
      }
    }
  } finally {
    clearInterval(heartbeat);
    try {
      await session?.close?.();
    } catch (error) {
      outcome = { phase: 'failed', error: `Could not close session: ${messageOf(error)}` };
    }
  }
  if (signal.aborted && outcome.phase === 'completed') outcome.phase = 'stopped';
  try {
    await update({ ...outcome, taskId: undefined });
    await activity('lifecycle', outcome.error ?? `Explorer ${outcome.phase}`);
  } catch (error) {
    status = { ...status, phase: 'failed', error: messageOf(error), updatedAt: new Date().toISOString() };
    options.onStatus({ ...status });
  }
  return status;
}
