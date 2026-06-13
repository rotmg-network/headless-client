import * as fs from 'fs';
import * as path from 'path';
import { Account, getCharAndServers, login } from './account-service';
import { Client } from './client';

function pickServer(
  servers: { name: string; address: string }[],
): { name: string; address: string } | undefined {
  return servers.find((s) => /^US/i.test(s.name)) ?? servers[0];
}

async function main(): Promise<void> {
  const file = path.resolve(process.cwd(), 'accounts.json');
  if (!fs.existsSync(file)) {
    console.error('accounts.json not found — copy accounts.example.json and fill in credentials.');
    process.exit(1);
  }
  const accounts: Account[] = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const acc of accounts) {
    const alias = acc.alias ?? acc.guid;
    try {
      console.log(`[${alias}] logging in...`);
      const { accessToken, clientToken } = await login(acc);
      const { char, servers } = await getCharAndServers(accessToken);
      const server = pickServer(servers);
      if (!server) {
        throw new Error('no servers returned');
      }
      console.log(
        `[${alias}] token OK — char ${char.charId} (${char.needsNewChar ? 'new' : 'existing'}), ` +
          `${servers.length} servers, using ${server.name} (${server.address})`,
      );
      new Client({
        alias,
        accessToken,
        clientToken,
        charId: char.charId,
        needsNewChar: char.needsNewChar,
        host: server.address,
      }).connect();
    } catch (err) {
      console.error(`[${alias}] login error:`, (err as Error).message);
    }
  }

  // Optional auto-exit so the spike terminates on its own when testing.
  const runSeconds = Number(process.env.RUN_SECONDS ?? '0');
  if (runSeconds > 0) {
    setTimeout(() => {
      console.log(`exiting after ${runSeconds}s`);
      process.exit(0);
    }, runSeconds * 1000);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
