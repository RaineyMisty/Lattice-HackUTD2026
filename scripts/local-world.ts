import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { worldConnection, type DbConnection, type WorldConnectionConfig } from '../spacetime_db/client/index.ts';

export function spacetimeCli() {
  const installed = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
  return {
    command: process.env.SPACETIME_CLI ?? (installed && existsSync(installed) ? installed : 'spacetime'),
    args: process.env.SPACETIME_ROOT ? ['--root-dir', process.env.SPACETIME_ROOT] : [],
  };
}

export function publisherToken() {
  const { command, args } = spacetimeCli();
  const login = spawnSync(command, [...args, 'login', 'show', '--token'], { encoding: 'utf8', windowsHide: true });
  if (login.error) throw login.error;
  const token = login.stdout?.match(/eyJ[A-Za-z0-9_.-]+/)?.[0];
  if (login.status !== 0 || !token) throw new Error('Run spacetime login before starting the local demo');
  return token;
}

export function connectDatabase(config: WorldConnectionConfig) {
  return new Promise<{ client: DbConnection; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Timed out connecting to SpacetimeDB')), 10_000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
      client.disconnect();
    };
    const client = worldConnection(config)
      .onConnect((client, _identity, token) => {
        clearTimeout(timer);
        resolve({ client, token });
      })
      .onConnectError((_context, error) => fail(error))
      .build();
  });
}

export async function grantOperator(owner: DbConnection, config: WorldConnectionConfig, worldIds: string | readonly string[]) {
  const { client, token } = await connectDatabase(config);
  try {
    for (const worldId of typeof worldIds === 'string' ? [worldIds] : worldIds) {
      await owner.reducers.setMember({ worldId, identity: client.identity!, role: 'operator' });
    }
    return token;
  } finally {
    client.disconnect();
  }
}
