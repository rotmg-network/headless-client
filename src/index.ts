import * as fs from 'fs';
import * as path from 'path';
import { Account, AppEngineError, getCharAndServers, login } from './account-service';
import { Client } from './client';
import { config, setConfig } from './config';

/**
 * A tiny stdin console for altering the global config and issuing commands
 * while the program runs. Commands:
 *   show                 — print the current config
 *   set <key> <value>    — change a config field
 *   vault <alias>        — tell a client to enter the vault
 *   realms <alias>       — list the realm portals a client can see
 */
function startConsole(clients: Map<string, Client>): void {
  console.log('console ready — commands: show | set <key> <value> | vault <alias> | realms <alias>');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const [cmd, ...args] = line.trim().split(/\s+/).filter(Boolean);
      if (!cmd) {
        continue;
      }
      switch (cmd) {
        case 'show':
          console.log(config);
          break;
        case 'set':
          console.log(setConfig(args[0], args[1]) ? `set ${args[0]} = ${args[1]}` : `invalid key/value: ${args[0]}`);
          break;
        case 'vault': {
          const client = clients.get(args[0]);
          if (client) {
            client.enterVault();
            console.log(`${args[0]}: entering vault`);
          } else {
            console.log(`no client: ${args[0]}`);
          }
          break;
        }
        case 'realms': {
          const client = clients.get(args[0]);
          if (client) {
            console.table(client.realmPortals());
          } else {
            console.log(`no client: ${args[0]}`);
          }
          break;
        }
        default:
          console.log(`unknown command: ${cmd}`);
      }
    }
  });
}

function pickServer(
  servers: { name: string; address: string }[],
  index: number,
): { name: string; address: string } | undefined {
  // Spread accounts across distinct servers to avoid per-server limits.
  return servers.length > 0 ? servers[index % servers.length] : undefined;
}

async function main(): Promise<void> {
  const file = path.resolve(process.cwd(), 'accounts.json');
  if (!fs.existsSync(file)) {
    console.error('accounts.json not found — copy accounts.example.json and fill in credentials.');
    process.exit(1);
  }
  const accounts: Account[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  // LOGIN_ONLY exercises the auth + char/list layer without connecting to a
  // game server (no socket, no account lock) — useful for testing error handling.
  const loginOnly = process.env.LOGIN_ONLY === '1';
  const clients = new Map<string, Client>();

  for (const [index, acc] of accounts.entries()) {
    const alias = acc.alias ?? acc.guid;
    try {
      console.log(`[${alias}] logging in...`);
      const { accessToken, clientToken } = await login(acc);
      const { char, servers } = await getCharAndServers(accessToken);
      const server = pickServer(servers, index);
      if (!server) {
        throw new Error('no servers returned');
      }
      console.log(
        `[${alias}] ready — char ${char.charId} (${char.needsNewChar ? 'new' : 'existing'}), ` +
          `${servers.length} servers, using ${server.name} (${server.address})`,
      );
      if (loginOnly) {
        continue;
      }
      const client = new Client({
        alias,
        accessToken,
        clientToken,
        charId: char.charId,
        needsNewChar: char.needsNewChar,
        host: server.address,
        autoEnterVault: acc.enterVault,
      });
      clients.set(alias, client);
      client.connect();
    } catch (err) {
      if (err instanceof AppEngineError) {
        const retry = err.retryAfterSeconds ? ` retry in ${err.retryAfterSeconds}s` : '';
        console.error(`[${alias}] ✗ ${err.kind}: ${err.message}${retry}  [server: ${err.detail}]`);
      } else {
        console.error(`[${alias}] ✗ error: ${(err as Error).message}`);
      }
    }
  }

  if (loginOnly) {
    process.exit(0);
  }

  // Interactive console for runtime config changes / commands (skip when piped).
  if (process.stdin.isTTY) {
    startConsole(clients);
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
