import type { ActivityRecord } from './database/interface.ts';

export function safeDiagnostic(message: string) {
  for (const key of [process.env.NVIDIA_API_KEY, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, process.env.LATTICE_STDB_TOKEN]) {
    if (key) message = message.replaceAll(key, '[redacted]');
  }
  return message.replace(/(?:sk|nvapi)-[\w-]{8,}|\beyJ[\w.-]{20,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

export function printAgentActivity(record: ActivityRecord) {
  const time = new Date(record.at).toLocaleTimeString('en-GB', { hour12: false });
  console.log(`[${time}] [${record.agentId}] [${record.kind}] ${safeDiagnostic(record.message)}`);
}
