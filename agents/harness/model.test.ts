import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nvidiaModel } from './model.ts';

test('NVIDIA lets the model select a tool and backs off on rate limiting', async t => {
  let attempts = 0;
  const call = { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"query":"checkout"}' } };
  t.mock.method(globalThis, 'fetch', async (input: unknown, options: RequestInit) => {
    assert.equal(String(input), 'https://integrate.api.nvidia.com/v1/chat/completions');
    const body = JSON.parse(String(options.body));
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.response_format, undefined);
    if (++attempts === 1) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
  });
  const activity: string[] = [];
  const result = await nvidiaModel('test-local-only').next(
    [{ role: 'user', content: 'Explore' }], [], AbortSignal.timeout(4000), row => activity.push(row),
  );
  assert.deepEqual(result.message.tool_calls, [call]);
  assert.equal(attempts, 2);
  assert.match(activity.join(' '), /429; retrying/);
});
