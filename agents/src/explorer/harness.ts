import { spawn } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from './codex-executable.js';

export interface HarnessSessionOptions {
  repositoryPath: string;
  agentId: string;
  sessionId: string;
  seed: number;
  startPath: string;
}

export interface HarnessTurn {
  prompt: string;
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
export const NVIDIA_NEMOTRON_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

export interface CodexHarnessOptions {
  provider?: CodexProvider;
  apiKey?: string;
  codexPath?: string;
  model?: string;
}

interface CodexLaunch {
  config: string[];
  env: NodeJS.ProcessEnv;
  model?: string;
  apiKey?: string;
}

function configureProvider(options: CodexHarnessOptions): CodexLaunch {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LATTICE_STDB_TOKEN;
  if (options.provider !== 'nvidia') {
    if (options.apiKey) env.CODEX_API_KEY = options.apiKey;
    return {
      config: [], model: options.model, apiKey: options.apiKey,
      env,
    };
  }
  const apiKey = (options.apiKey ?? process.env.NVIDIA_API_KEY)?.trim();
  if (!apiKey) throw new Error('NVIDIA_API_KEY is required when using --provider nvidia');

  env.NVIDIA_API_KEY = apiKey;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return {
    model: options.model ?? NVIDIA_NEMOTRON_MODEL,
    apiKey,
    env,
    config: [
      'model_provider="nvidia"',
      'model_providers.nvidia.name="NVIDIA Build"',
      'model_providers.nvidia.base_url="https://integrate.api.nvidia.com/v1"',
      'model_providers.nvidia.wire_api="responses"',
      'model_providers.nvidia.env_key="NVIDIA_API_KEY"',
      'model_providers.nvidia.requires_openai_auth=false',
      'model_providers.nvidia.supports_websockets=false',
      'model_reasoning_effort="low"',
      'shell_environment_policy.exclude=["NVIDIA_API_KEY"]',
    ],
  };
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
}

export class CodexHarness implements CodingHarness {
  private readonly launch: CodexLaunch;

  constructor(private readonly options: CodexHarnessOptions = {}) {
    this.launch = configureProvider(options);
  }

  openSession({ repositoryPath }: HarnessSessionOptions): HarnessSession {
    const executable = resolveCodexExecutable(this.options.codexPath);
    const launch = this.launch;
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
            ...launch.config.flatMap(config => ['-c', config]),
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
      if (event.type === 'turn.failed') failure = event.error?.message || 'Codex turn failed';
      if (event.type === 'error') failure ??= event.message;
      if (event.type === 'turn.completed') completed = true;
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
