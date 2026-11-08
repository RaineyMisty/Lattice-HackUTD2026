import type { AgentDatabase, AgentId, AgentState, EvidencePayload, SourceRecord } from '../../contracts/src/index.js';

/** All agent data IO crosses a database transport boundary. */
export class HttpAgentDatabase implements AgentDatabase {
  private generation: number | undefined;
  constructor(private readonly options: { baseUrl: string; agentId: AgentId; token: string; signal?: AbortSignal }) {}

  private async request(id: AgentId, endpoint: string, body?: unknown): Promise<Response> {
    if (id !== this.options.agentId) throw new Error('Agent cannot impersonate another role');
    const headers: Record<string, string> = { Authorization: `Bearer ${this.options.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.generation !== undefined) headers['X-Lattice-Generation'] = String(this.generation);
    const response = await fetch(`${this.options.baseUrl}/api/agents/${id}/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.options.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(error.error ?? `Database returned HTTP ${response.status}`);
    }
    return response;
  }

  async readSources(id: AgentId): Promise<SourceRecord[]> {
    const data = await (await this.request(id, 'sources')).json() as { generation: number; sources: SourceRecord[] };
    this.generation = data.generation;
    return data.sources;
  }
  async submitEvidence(id: AgentId, sourceId: string, payload: EvidencePayload): Promise<void> {
    await this.request(id, 'evidence', { sourceId, payload });
  }
  async updateStatus(id: AgentId, status: AgentState['status'], message: string): Promise<void> {
    await this.request(id, 'status', { status, message });
  }
}
