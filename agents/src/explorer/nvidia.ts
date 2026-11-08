import type { CodingHarness, HarnessSessionOptions, HarnessTurn } from './harness.ts';
import { liveWorldOutputSchema } from './worldProtocol.ts';
import { indexSources, isAllowedSourcePath, readRepositorySource, readRevisionSource, revisionPaths, searchSource } from './repository.ts';

export const NVIDIA_NEMOTRON_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const url = 'https://integrate.api.nvidia.com/v1/chat/completions';
const maxActions = 6;
class NvidiaTokenLimit extends Error {}

function tool(name: string, description: string, fields: Record<string, 'string' | 'integer'>, required: string[]) {
  return { type: 'function', function: { name, description, parameters: {
    type: 'object', additionalProperties: false, required,
    properties: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, { type }])),
  } } };
}

const tools = [
  tool('list_files', 'List up to 80 repository paths under a prefix. Start at offset 0; follow nextOffset to see more.', { prefix: 'string', offset: 'integer' }, []),
  tool('search', 'Find literal text in the repository. Narrow by a file or directory prefix when helpful.', { query: 'string', prefix: 'string' }, ['query']),
  tool('read_lines', 'Read up to 80 numbered lines from a repository file. Read the relevant lines before citing them.', { path: 'string', startLine: 'integer' }, ['path']),
];

const { $schema: _draft, ...discoveryParameters } = liveWorldOutputSchema;
const publishTool = { type: 'function', function: {
  name: 'publish_discovery',
  description: 'Immediately write a small batch of discoveries or follow-up tasks to the shared map. Cite only numbered source lines you have seen. Use empty arrays for unused fields.',
  parameters: discoveryParameters,
} };
const completedWorldTurn = JSON.stringify({ entities: [], relations: [], behaviors: [], tasks: [] });

interface ToolCall { id: string; function: { name: string; arguments: string } }
interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}
interface Completion {
  choices?: { message: Message; finish_reason?: string }[];
}

export class NvidiaHarness implements CodingHarness {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    const key = (options.apiKey ?? process.env.NVIDIA_API_KEY)?.trim();
    if (!key) throw new Error('NVIDIA_API_KEY is required when using the NVIDIA model');
    this.apiKey = key;
    this.model = options.model ?? NVIDIA_NEMOTRON_MODEL;
  }

  openSession({ repositoryPath, seed }: HarnessSessionOptions) {
    let cached: { commit?: string; paths: string[] } | undefined;
    return { run: async (turn: HarnessTurn) => {
      const { commit, signal } = turn;
      const publish = turn.source && turn.publishDiscovery;
      const observed = turn.source ? [turn.source] : [];
      const budget = publish ? 3 : maxActions;
      const messages: Message[] = [{
        role: 'user',
        content: turn.prompt + (publish
          ? '\n\nLive mode: the assigned numbered preview is already read from Git. Publish a small batch now via publish_discovery. Cite path and line range only; omit excerpt. Prefer application services or concrete code symbols. Queue a specific file when another task can resolve a dependency. Use tools for further evidence, and publish as soon as you find it. Say DONE when the task has no immediate follow-up.'
          : '\n\nExploration phase: use the tools to find and read relevant source. Read at least one file before saying READY. The discovery JSON will be requested separately.'),
      }];
      let hasRead = false;
      let actions = 0;
      let queued = false;
      const read = (path: string) => commit
        ? readRevisionSource(repositoryPath, commit, path, signal) : readRepositorySource(repositoryPath, path);
      async function use(call: ToolCall) {
        if (publish && call.function.name === 'publish_discovery') {
          const receipt = await publish(call.function.arguments, observed);
          queued ||= receipt.tasks > 0;
          return receipt;
        }
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const prefix = typeof args.prefix === 'string' ? args.prefix.replaceAll('\\', '/').replace(/\/$/, '') : '';
        const { name } = call.function;
        if (prefix && !isAllowedSourcePath(prefix)) throw new Error('Expected a repository-relative prefix');
        if (name === 'list_files') {
          if (!cached || cached.commit !== commit) {
            const paths = commit ? await revisionPaths(repositoryPath, commit, signal) : await indexSources(repositoryPath);
            cached = { commit, paths: paths.filter(isAllowedSourcePath) };
          }
          const matches = prefix ? cached.paths.filter(path => path === prefix || path.startsWith(prefix + '/')) : cached.paths;
          const offset = typeof args.offset === 'number' && Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
          const paths = matches.slice(offset, offset + 80);
          return { paths, nextOffset: offset + paths.length < matches.length ? offset + paths.length : null };
        }
        if (name === 'search' && typeof args.query === 'string' && args.query.trim().length >= 2 && args.query.length <= 120 && !/[\r\n\0]/.test(args.query)) {
          return { matches: await searchSource(repositoryPath, commit, args.query, prefix, signal) };
        }
        if (name === 'read_lines' && typeof args.path === 'string') {
          const source = await read(args.path);
          const start = typeof args.startLine === 'number' && Number.isSafeInteger(args.startLine) ? Math.max(1, args.startLine) : 1;
          const all = source.text.split('\n');
          const lines = all.slice(start - 1, start + 79).map((text, index) => ({ line: start + index, text: text.slice(0, 320) }));
          hasRead ||= lines.some(line => line.text.trim().length > 0);
          if (lines.length) observed.push({ path: source.path, startLine: start, endLine: start + lines.length - 1 });
          return { path: source.path, lines, nextLine: start + lines.length <= all.length ? start + lines.length : null };
        }
        throw new Error('Invalid repository tool or arguments');
      }

      for (let step = 0; step < budget && actions < budget; step++) {
        const message = await this.complete(messages, seed, signal, {
          tools: publish ? [...tools, publishTool] : tools,
          tool_choice: publish ? (step === 0 ? { type: 'function', function: { name: 'publish_discovery' } } : 'auto')
            : hasRead ? 'auto' : 'required',
          parallel_tool_calls: false,
          ...(publish ? { max_tokens: 1600, reasoning_effort: 'none' } : {}),
        }).catch(async error => {
          if (!publish || !(error instanceof NvidiaTokenLimit)) throw error;
          await turn.onActivity('NVIDIA reached the request token budget; moving to the next database task');
          return undefined;
        });
        if (!message) break;
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
          if (publish || hasRead) break;
          messages.push(message, { role: 'user', content: 'Call read_lines on an actual repository file before completing exploration.' });
          continue;
        }
        messages.push(message);
        for (const call of calls) {
          let result: unknown;
          try {
            result = ++actions <= budget ? await use(call) : { error: 'Tool budget exhausted' };
          } catch (error) {
            signal.throwIfAborted();
            result = { error: error instanceof Error ? error.message.split('\n')[0] : 'Repository tool failed' };
          }
          const status = result && typeof result === 'object' && 'error' in result ? 'failed'
            : call.function.name === 'publish_discovery' ? 'received by the database adapter' : 'returned source data';
          await turn.onActivity('NVIDIA tool ' + call.function.name + ': ' + status);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
        if (queued) break;
      }
      if (publish) return completedWorldTurn;
      if (!hasRead) throw new Error('NVIDIA exploration finished without reading repository source');
      messages.push({
        role: 'user',
        content: 'Submit the discovery JSON now. Use evidence you read, including the assigned source. Report the smallest supported graph fragment and concrete follow-up files. If the evidence only establishes a file, submit that file as an entity with an exact source citation.',
      });
      await turn.onActivity('NVIDIA is producing a structured discovery from source evidence');
      const { content } = await this.complete(messages, seed, signal, {
        response_format: { type: 'json_schema', json_schema: { name: 'lattice_discovery', schema: turn.outputSchema } },
      });
      if (!content) throw new Error('NVIDIA returned no structured discovery');
      return content;
    } };
  }

  private async complete(messages: Message[], seed: number, signal: AbortSignal, options: object) {
    const response = await fetch(url, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, seed, stream: false, max_tokens: 4096, reasoning_effort: 'low', ...options }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`NVIDIA API returned HTTP ${response.status}`);
    }
    const { choices } = await response.json() as Completion;
    const choice = choices?.[0];
    if (!choice?.message) throw new Error('NVIDIA API returned no model message');
    if (choice.finish_reason === 'length') throw new NvidiaTokenLimit('NVIDIA response reached its token limit');
    return choice.message;
  }
}
