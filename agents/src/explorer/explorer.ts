import { setTimeout as pause } from 'node:timers/promises';
import type { ActivityRecord, AgentScope, AgentStatus, ExplorationContext, ExplorationDatabase, ExplorationTask } from '../database/interface.ts';
import type { CodingHarness, HarnessSession } from './harness.ts';
import { turnOutputSchema, verifyTurn } from './protocol.ts';

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
  turnTimeoutMs: number;
  onStatus(status: AgentStatus): void;
}

function promptFor(skill: string, status: AgentStatus, task: ExplorationTask, context: ExplorationContext) {
  const contextData = {
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
      const claim = await database.claimTask(scope, preferredId, signal);
      preferredId = undefined;
      current = claim.task;
      if (!current) {
        if (!claim.inFlight) break;
        if (status.phase !== 'waiting') await update({ phase: 'waiting', taskId: undefined });
        await pause(150, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      await update({ phase: 'running', taskId: current.id });
      await activity('task', `Exploring ${current.path}`);
      session ??= await harness.openSession({
        repositoryPath, agentId: scope.agentId, sessionId: scope.sessionId,
        seed: status.seed, startPath: status.startPath,
      });
      const context = await database.readContext(scope.runId, 18, signal);
      const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(options.turnTimeoutMs)]);
      const response = await session.run({
        prompt: promptFor(options.skill, status, current, context),
        outputSchema: turnOutputSchema,
        signal: turnSignal,
        onActivity: async message => {
          turnSignal.throwIfAborted();
          await activity('tool', message.slice(0, 300));
        },
      });
      const { batch, rejected } = await verifyTurn(repositoryPath, response, scope.agentId, turnSignal);
      await database.commitDiscovery(scope, current.id, batch, turnSignal);
      current = null;
      await update({ turns: status.turns + 1, taskId: undefined });
      await activity('verification', `${batch.nodes.length} nodes, ${batch.edges.length} edges, ${batch.tasks.length} follow-ups; ${rejected.length} rejected`);
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
