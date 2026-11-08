import { spawn } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from './codex-executable.js';
import { NvidiaHarness } from './nvidia.ts';
import type { SourceRange } from './worldProtocol.ts';
export { NVIDIA_NEMOTRON_MODEL } from './nvidia.ts';

export interface HarnessSessionOptions {
  repositoryPath: string;
  agentId: string;
  sessionId: string;
  seed: number;
  startPath: string;
}

export interface HarnessTurn {
  prompt: string;
  commit?: string;
  source?: SourceRange;
  publishDiscovery?(response: string, observed: readonly SourceRange[]): Promise<{ facts: number; tasks: number; rejected: number }>;
  outputSchema: object;
  signal: AbortSignal;
  onActivity(message: string): Promise<void>;
}

export interface HarnessSession {
  run(turn: HarnessTurn): Promise<string>;
  close?(): Promise<void>;
}

export interface CodingHarness {
  openSession(options: HarnessSessionOptions): HarnessSession | Promise<HarnessSession>;
}

export type CodexProvider = 'openai' | 'nvidia';

export interface CodexHarnessOptions {
  provider?: CodexProvider;
  apiKey?: string;
  codexPath?: string;
  model?: string;
}

interface CodexLaunch {
  env: NodeJS.ProcessEnv;
  model?: string;
  apiKey?: string;
}

function configureCodex(options: CodexHarnessOptions): CodexLaunch {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LATTICE_STDB_TOKEN;
  delete env.NVIDIA_API_KEY;
  if (options.apiKey) env.CODEX_API_KEY = options.apiKey;
  return { env, model: options.model, apiKey: options.apiKey };
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class CodexHarness implements CodingHarness {
  private readonly nvidia?: NvidiaHarness;

  constructor(private readonly options: CodexHarnessOptions = {}) {
    if (options.provider === 'nvidia') this.nvidia = new NvidiaHarness(options);
  }

  openSession(options: HarnessSessionOptions): HarnessSession {
    if (this.nvidia) return this.nvidia.openSession(options);
    const { repositoryPath } = options;
    const executable = resolveCodexExecutable(this.options.codexPath);
    const launch = configureCodex(this.options);
    let threadId: string | undefined;
    return {
      async run(turn) {
        turn.signal.throwIfAborted();
        const folder = await mkdtemp(join(tmpdir(), 'lattice-explorer-'));
        const schemaPath = join(folder, 'turn.json');
        try {
          await writeFile(schemaPath, JSON.stringify(turn.outputSchema), { flag: 'wx' });
          const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--output-schema', schemaPath];
          if (launch.model) common.push('--model', launch.model);
          const args = [
            '--ask-for-approval', 'never', '-c', 'web_search="disabled"',
            '-c', 'sandbox_workspace_write.network_access=false',
            'exec', '--sandbox', 'read-only', '--cd', repositoryPath,
            ...(threadId ? ['resume', ...common, threadId, '-'] : [...common, '-']),
          ];
          const result = await runCodex(executable, args, repositoryPath, launch, turn);
          threadId = result.threadId ?? threadId;
          if (!threadId) throw new Error('Codex did not identify its session');
          return result.response;
        } finally {
          await unlink(schemaPath).catch(() => undefined);
          await rmdir(folder).catch(() => undefined);
        }
      },
    };
  }
}

async function runCodex(executable: string, args: string[], cwd: string, launch: CodexLaunch, turn: HarnessTurn) {
  turn.signal.throwIfAborted();
  await turn.onActivity(`Launching Codex CLI${launch.model ? ` with ${launch.model}` : ''}`);
  turn.signal.throwIfAborted();
  const child = spawn(executable, args, {
    cwd, windowsHide: true, signal: turn.signal,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let spawnError: Error | undefined;
  let stderr = '';
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  child.on('error', error => { spawnError = error; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + String(data)).slice(-1500); });
  child.stdin.on('error', error => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') spawnError ??= error;
  });
  child.stdin.end(turn.prompt);
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let response = '';
  let completed = false;
  let threadId: string | undefined;
  let failure: string | undefined;
  try {
    for await (const line of output) {
      turn.signal.throwIfAborted();
      if (!line.trim()) continue;
      const event = JSON.parse(line) as CodexEvent;
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.type === 'turn.started') await turn.onActivity('Codex turn started; waiting for provider output');
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex turn failed';
      if (event.type === 'error') failure ??= event.message;
      if (event.type === 'turn.completed') {
        completed = true;
        const { input_tokens: input, output_tokens: output } = event.usage ?? {};
        await turn.onActivity(typeof input === 'number' && typeof output === 'number'
          ? `Codex turn completed (${input} input, ${output} output tokens reported)`
          : 'Codex turn completed');
      }
      if (event.type === 'item.started' && event.item?.type === 'command_execution') {
        await turn.onActivity('Inspecting repository with a shell tool');
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') response = event.item.text ?? '';
    }
    const code = await exited;
    turn.signal.throwIfAborted();
    if (spawnError) throw spawnError;
    if (code !== 0 || failure || !completed || !response) {
      let detail = failure || stderr.trim() || 'No completed discovery result';
      if (launch.apiKey) detail = detail.replaceAll(launch.apiKey, '[redacted]');
      detail = detail.replace(/(?:sk|nvapi)-[\w-]{8,}/g, '[redacted]');
      throw new Error(`Codex failed (exit ${code}): ${detail}`);
    }
    return { response, threadId };
  } finally {
    output.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}
