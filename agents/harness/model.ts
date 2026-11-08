import { setTimeout as delay } from 'node:timers/promises';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface Tool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}
export interface Model {
  next(messages: readonly Message[], tools: readonly Tool[], signal: AbortSignal, log: (text: string) => void):
    Promise<{ message: Extract<Message, { role: 'assistant' }>; truncated?: boolean }>;
}

export class ModelConfigurationError extends Error {}

export function nvidiaModel(apiKey = process.env.NVIDIA_API_KEY, model = process.env.LATTICE_NVIDIA_MODEL): Model {
  const key = apiKey?.trim();
  if (!key) throw new ModelConfigurationError('Set NVIDIA_API_KEY before starting exploration');
  return {
    async next(messages, tools, signal, log) {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
          method: 'POST', signal,
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model || 'nvidia/nemotron-3.5-super-vl-120b-a12b', messages, tools,
            tool_choice: 'required', parallel_tool_calls: false, reasoning_effort: 'none', max_tokens: 1800, stream: false,
          }),
        }).catch(error => { signal.throwIfAborted(); throw new Error('NVIDIA network request failed', { cause: error }); });
        if (response.ok && response.status !== 202) {
          const result = await response.json() as {
            choices?: { message: Extract<Message, { role: 'assistant' }>; finish_reason?: string }[];
          };
          const choice = result.choices?.[0];
          if (!choice?.message) throw new Error('NVIDIA returned no model message');
          return {
            message: { role: 'assistant', content: choice.message.content ?? null, tool_calls: choice.message.tool_calls },
            truncated: choice.finish_reason === 'length',
          };
        }
        await response.body?.cancel();
        const status = response.status;
        if ([400, 401, 403, 404, 422].includes(status)) throw new ModelConfigurationError('NVIDIA API rejected the request (HTTP ' + status + ')');
        if ((status !== 429 && status < 500) || attempt >= 3) throw new Error('NVIDIA API returned HTTP ' + status);
        const header = response.headers.get('retry-after');
        const seconds = header ? Number(header) : NaN;
        const wait = Number.isFinite(seconds) && seconds >= 0 ? Math.min(15_000, Math.max(500, seconds * 1000)) : 1000 * 2 ** attempt;
        log('NVIDIA HTTP ' + status + '; retrying in ' + Math.ceil(wait / 1000) + 's');
        await delay(wait, undefined, { signal });
      }
    },
  };
}
