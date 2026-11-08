import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Findings } from '../spacetimedb/client.ts';
import { explorationTools } from './tools.ts';

test('publish accepts observed path citations, returns endpoint refs, and finishes without a reason', async () => {
  const source: Record<string, string[]> = {
    'src/main.py': ['def checkout():', '    return charge()'],
    'src/billing.py': ['def charge():', '    return 42'],
  };
  const writes: Findings[] = [];
  const session = explorationTools({
    files: new Set(Object.keys(source)),
    async read(path) { return source[path]; },
    list() { return { paths: Object.keys(source), nextOffset: null }; },
    async search() { return []; },
  }, {
    find() { return []; },
    async publish(batch) { writes.push(batch); },
  }, { id: 'task', path: 'src/main.py', question: 'Trace checkout', attempt: 1 }, new AbortController().signal, () => {});
  await session.read('src/main.py', 1);
  await session.read('src/billing.py', 1);
  const call = (tool: string, data: object) => session.call(tool, JSON.stringify(data));
  const first = await call('publish_discovery', {
    entities: { kind: 'function', symbol: 'checkout', source: { path: 'src/main.py', startLine: 1 } },
  });
  const { refs } = first.result as { refs: { ref: string }[] };
  assert.equal(refs.length, 1);
  const second = await call('publish_discovery', {
    entities: [{ kind: 'file', symbol: 'billing.py', source: { path: 'src/billing.py', line: 1 } },
      { kind: 'function', symbol: 'out-of-range', source: { path: 'src/main.py', line: 99 } }],
    relations: { from: refs[0].ref, to: 'src/billing.py', kind: 'calls', source: { path: 'src/main.py', line: 2 } },
  });
  assert.equal(writes[1].entities.length, 1);
  assert.equal(writes[1].entities[0].symbol, '');
  assert.equal(writes[1].relations[0].source.excerpt, 'return charge()');
  assert.equal((second.result as { rejected: string[] }).rejected.length, 1);
  const oversized = await call('publish_discovery', {
    tasks: Array.from({ length: 13 }, (_, index) => ({ path: 'src/billing.py', question: 'Inspect branch ' + index })),
  });
  assert.equal(writes[2].tasks.length, 12);
  assert.match((oversized.result as { rejected: string[] }).rejected[0], /remaining items/);
  assert.equal((await call('finish_task', {})).result, 'completed');
});
