import { z } from 'zod';
import { nodeKinds, relationshipKinds } from '../database/interface.ts';
import type { DiscoveryBatch, NodeRef, SourceEvidence } from '../database/interface.ts';
import { readRepositorySource, stableId } from './repository.ts';

const nodeRef = z.strictObject({ kind: z.enum(nodeKinds), name: z.string().trim().min(1).max(240), path: z.string().max(1000) });
const citation = z.strictObject({
  path: z.string().max(1000), startLine: z.number().int().min(1),
  endLine: z.number().int().min(1), quote: z.string().min(1).max(2400),
});
const turnSchema = z.strictObject({
  nodes: z.array(z.strictObject({ node: nodeRef, evidence: citation })).max(24),
  edges: z.array(z.strictObject({
    from: nodeRef, to: nodeRef, relationship: z.enum(relationshipKinds), evidence: citation,
  })).max(32),
  tasks: z.array(z.strictObject({ path: z.string().max(1000), question: z.string().trim().min(1).max(400) })).max(8),
});

export const turnOutputSchema = z.toJSONSchema(turnSchema, { target: 'draft-7' });
const nodeId = ({ kind, path, name }: NodeRef) => stableId('node', kind, path, name);

export async function verifyTurn(root: string, response: string, agentId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const turn = turnSchema.parse(JSON.parse(response));
  const batch: DiscoveryBatch = { nodes: [], edges: [], evidence: [], tasks: [] };
  const rejected: string[] = [];
  const files = new Map<string, ReturnType<typeof readRepositorySource>>();

  function read(path: string) {
    let pending = files.get(path);
    if (!pending) {
      pending = readRepositorySource(root, path);
      files.set(path, pending);
    }
    return pending;
  }
  async function canonicalNode(node: NodeRef): Promise<NodeRef> {
    return { ...node, path: (await read(node.path)).path };
  }
  async function checkEvidence(input: z.infer<typeof citation>): Promise<SourceEvidence> {
    const source = await read(input.path);
    const lines = source.text.split('\n');
    const { startLine, endLine } = input;
    const quote = input.quote.replaceAll('\r\n', '\n');
    if (endLine < startLine || endLine - startLine > 39 || endLine > lines.length || !quote.trim()
      || !lines.slice(startLine - 1, endLine).join('\n').includes(quote)) {
      throw new Error('Quoted text does not match the cited source lines');
    }
    return {
      id: stableId('evidence', source.path, startLine, endLine, quote),
      path: source.path, startLine, endLine, quote, verification: 'source-matched',
    };
  }
  async function verify(kind: string, check: () => Promise<void>) {
    signal.throwIfAborted();
    try {
      await check();
    } catch (error) {
      signal.throwIfAborted();
      rejected.push(`${kind}: ${error instanceof Error ? error.message : 'invalid discovery'}`);
    }
  }
  for (const item of turn.nodes) {
    await verify('Node', async () => {
      const node = await canonicalNode(item.node);
      const evidence = await checkEvidence(item.evidence);
      batch.nodes.push({ ...node, id: nodeId(node), evidenceIds: [evidence.id], agentId });
      batch.evidence.push(evidence);
    });
  }
  for (const item of turn.edges) {
    await verify('Edge', async () => {
      const [from, to] = await Promise.all([canonicalNode(item.from), canonicalNode(item.to)]);
      const evidence = await checkEvidence(item.evidence);
      const [fromId, toId] = [nodeId(from), nodeId(to)];
      batch.edges.push({
        id: stableId('edge', fromId, toId, item.relationship), fromId, toId,
        relationship: item.relationship, evidenceIds: [evidence.id], agentId,
      });
      batch.evidence.push(evidence);
    });
  }
  for (const task of turn.tasks) {
    await verify('Task', async () => {
      const { path } = await read(task.path);
      batch.tasks.push({ id: stableId('task', path, task.question), path, question: task.question });
    });
  }
  signal.throwIfAborted();
  return { batch, rejected };
}
