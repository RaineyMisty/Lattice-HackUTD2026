import type { AgentDatabase, AgentId, AgentState, EvidencePayload, SourceRecord } from '../../contracts/src/index.js';

/** Implement this port with generated bindings after publishing your module.
 * Each process receives its own enrolled SpacetimeDB identity/token. Never share an admin token.
 * The port deliberately exposes no write operation for risk, task or notification tables.
 */
export interface SpacetimeAgentPort {
  readAssignedSources(): Promise<Array<SourceRecord & { epoch: number }>>;
  submitEvidence(sourceId: string, payloadJson: string, expectedEpoch: number): Promise<void>;
  updateStatus(status: AgentState['status'], message: string, expectedEpoch: number): Promise<void>;
}

export class SpacetimeAgentDatabase implements AgentDatabase {
  private epoch: number | undefined;
  constructor(private readonly agentId: AgentId, private readonly port: SpacetimeAgentPort) {}
  private authorize(id: AgentId) { if (id !== this.agentId) throw new Error('Agent role mismatch'); }
  private expectedEpoch(): number {
    if (this.epoch === undefined) throw new Error('Read the assigned source before submitting agent writes');
    return this.epoch;
  }
  async readSources(id: AgentId) {
    this.authorize(id);
    const sources = await this.port.readAssignedSources();
    if (!sources.length) throw new Error('No source is assigned to this agent for the active incident');
    const epoch = sources[0].epoch;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || sources.some(source => source.epoch !== epoch)) {
      throw new Error('Assigned source subscription does not contain a coherent run epoch');
    }
    if (this.epoch !== undefined && this.epoch !== epoch) throw new Error('Investigation changed; create a new database adapter for the new agent run');
    this.epoch = epoch;
    return sources.map(({ epoch: _epoch, ...source }) => source);
  }
  async submitEvidence(id: AgentId, sourceId: string, payload: EvidencePayload) {
    this.authorize(id); await this.port.submitEvidence(sourceId, JSON.stringify(payload), this.expectedEpoch());
  }
  async updateStatus(id: AgentId, status: AgentState['status'], message: string) {
    this.authorize(id); await this.port.updateStatus(status, message, this.expectedEpoch());
  }
}
