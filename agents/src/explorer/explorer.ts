import { setTimeout as pause } from 'node:timers/promises';
import type { ActivityRecord, AgentScope, AgentStatus, ExplorationContext, ExplorationDatabase, ExplorationTask } from '../database/interface.ts';
import type { CodingHarness, HarnessSession } from './harness.ts';
import { turnOutputSchema, verifyTurn } from './protocol.ts';
import { readRevisionSource } from './repository.ts';
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
  turnTimeoutMs: number;
  onStatus(status: AgentStatus): void;
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 450);

export async function runExplorer(options: ExplorerOptions): Promise<AgentStatus> {
  const { scope, database, harness, repositoryPath, signal } = options;
  let status = { ...options.initialStatus };
  let session: HarnessSession | undefined;
  let current: ExplorationTask | null = null;
  let preferredId: string | undefined = options.initialTaskId;

  async function update(patch: Partial<AgentStatus>) {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    options.onStatus({ ...status });
    await database.writeStatus(scope, status);
  }
  async function activity(kind: ActivityRecord['kind'], message: string) {
    await database.appendActivity(scope, {
      at: new Date().toISOString(), agentId: scope.agentId, kind, message, taskId: current?.id,
    });
  }

  let outcome: Pick<AgentStatus, 'phase' | 'error'> = { phase: 'completed' };
  try {
    await update({ phase: 'running' });
    await activity('lifecycle', `Started from ${status.startPath}`);
    while (status.turns < options.maxTurns) {
      signal.throwIfAborted();
      const claim = await database.claimTask(scope, preferredId, signal, options.turnTimeoutMs + 15_000);
      preferredId = undefined;
      current = claim.task;
      if (!current) {
        if (!claim.inFlight && !options.stayOpen) break;
        if (status.phase !== 'waiting') await update({ phase: 'waiting', taskId: undefined });
        if (database.waitForWork) await database.waitForWork(scope, options.stayOpen, signal);
        else await pause(150, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      await update({ phase: 'running', taskId: current.id });
      await activity('task', `Exploring ${current.path}`);
      session ??= await harness.openSession({
        repositoryPath, agentId: scope.agentId, sessionId: scope.sessionId,
        seed: status.seed, startPath: status.startPath,
      });
      const context = await database.readContext(scope.runId, 18, signal, scope);
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(options.turnTimeoutMs)]);
      const source = options.commit
        ? (await readRevisionSource(repositoryPath, options.commit, current.path, turnSignal)).text
          .split('\n').slice(0, 160).map((line, i) => `${i + 1}: ${line}`).join('\n').slice(0, 12_000)
        : undefined;
      const response = await session.run({
        prompt: promptFor(options.skill, status, current, context, source),
        outputSchema: options.commit ? worldOutputSchema : turnOutputSchema,
        signal: turnSignal,
        onActivity: async message => {
          turnSignal.throwIfAborted();
          await activity('tool', message.slice(0, 300));
        },
      });
      let summary: string;
      if (options.commit && context.world) {
        const { update: world, rejected } = await verifyWorldUpdate(repositoryPath, options.commit, response, context.world, turnSignal);
        if (rejected.length && !world.entities.length && !world.relations.length && !world.behaviors.length && !world.tasks.length) {
          throw new Error(`No proposed discovery passed verification: ${rejected[0]}`);
        }
        await database.commitDiscovery(scope, current.id, { nodes: [], edges: [], evidence: [], tasks: [], world }, turnSignal);
        summary = `${world.entities.length} entities, ${world.relations.length} relations, ${world.behaviors.length} behaviors, ${world.tasks.length} follow-ups; ${rejected.length} rejected`;
        if (rejected.length) summary += ` (${rejected[0].slice(0, 160)})`;
      } else {
        const { batch, rejected } = await verifyTurn(repositoryPath, response, scope.agentId, turnSignal);
        await database.commitDiscovery(scope, current.id, batch, turnSignal);
        summary = `${batch.nodes.length} nodes, ${batch.edges.length} edges, ${batch.tasks.length} follow-ups; ${rejected.length} rejected`;
      }
      current = null;
      await update({ turns: status.turns + 1, taskId: undefined });
      await activity('verification', summary);
    }
  } catch (error) {
    outcome = signal.aborted ? { phase: 'stopped' } : { phase: 'failed', error: messageOf(error) };
    if (current) {
      try {
        await database.settleTask(scope, current.id, signal.aborted ? 'release' : 'failed');
      } catch (cleanupError) {
        outcome = { phase: 'failed', error: `Could not settle claim: ${messageOf(cleanupError)}` };
      }
    }
  } finally {
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
