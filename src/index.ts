import * as fs from 'fs';
import * as path from 'path';
import { Account, AppEngineError, getCharAndServers, login, ServerInfo } from './account-service';
import { Client } from './client';
import { config, setConfig } from './config';
import { PluginManager } from './plugin-manager';
import { GameIdChecker } from './plugins/game-id-checker';
import { RealmHostMapper } from './plugins/realm-host-mapper';

/**
 * A tiny stdin console for altering the global config and issuing commands
 * while the program runs. Commands:
 *   show                      — print the current config
 *   set <key> <value>         — change a config field
 *   vault <alias>             — tell a client to enter the vault
 *   escape <alias>            — send the client back to the nexus
 *   connect <alias> <server>  — connect a client to a server (name or host)
 *   realms <alias>            — list the realm portals a client can see
 *   hosts <alias>             — list RealmHostMapper's portal -> host table
 *   gameids <alias>           — list game-id-checker probe results
 */
function startConsole(clients: Map<string, Client>, servers: ServerInfo[], plugins: PluginManager): void {
  console.log(
    'console ready — show | set <k> <v> | vault <a> | escape <a> | connect <a> <server> | realms <a> | hosts <a> | gameids <a> | plugins <a> | plugin <a> load|unload <name>',
  );
  const withClient = (alias: string, fn: (client: Client) => void): void => {
    const client = clients.get(alias);
    if (client) {
      fn(client);
    } else {
      console.log(`no client: ${alias}`);
    }
  };
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
        case 'vault':
          withClient(args[0], (c) => c.enterVault());
          break;
        case 'escape':
          withClient(args[0], (c) => c.escape());
          break;
        case 'connect': {
          const target = args[1] ?? '';
          const server = servers.find((s) => s.name.toLowerCase() === target.toLowerCase());
          if (!server && !target) {
            console.log('usage: connect <alias> <server-name-or-host>');
            break;
          }
          withClient(args[0], (c) => c.connectToServer(server?.address ?? target));
          break;
        }
        case 'realms':
          withClient(args[0], (c) => console.table(c.realmPortals()));
          break;
        case 'hosts':
          withClient(args[0], (c) => {
            const mapper = plugins.get<RealmHostMapper>(c, 'RealmHostMapper');
            if (!mapper) {
              console.log(`[${c.alias}] RealmHostMapper is not loaded`);
              return;
            }
            console.table(mapper.portals());
          });
          break;
        case 'gameids':
          withClient(args[0], (c) => {
            const checker = plugins.get<GameIdChecker>(c, 'game-id-checker');
            if (!checker) {
              console.log(`[${c.alias}] game-id-checker is not loaded`);
              return;
            }
            console.table(checker.checks());
          });
          break;
        case 'plugins':
          withClient(args[0], (c) => {
            console.log(`[${c.alias}] loaded: [${plugins.loaded(c).join(', ') || 'none'}]`);
            console.table(plugins.available());
          });
          break;
        case 'plugin': {
          // plugin <alias> load|unload <name>
          const [alias, action, name] = args;
          withClient(alias, (c) => {
            if (action === 'load') {
              plugins.load(c, name);
            } else if (action === 'unload') {
              plugins.unload(c, name);
            } else {
              console.log('usage: plugin <alias> load|unload <name>');
            }
          });
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
  const plugins = new PluginManager();
  let serverList: ServerInfo[] = [];

  for (const [index, acc] of accounts.entries()) {
    const alias = acc.alias ?? acc.guid;
    try {
      console.log(`[${alias}] logging in...`);
      const { accessToken, clientToken } = await login(acc);
      const { char, servers } = await getCharAndServers(accessToken);
      serverList = servers;
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
        servers,
        autoEnterVault: acc.enterVault,
      });
      clients.set(alias, client);
      for (const name of acc.plugins ?? []) {
        plugins.load(client, name);
      }
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

  // Interactive console for runtime config changes / commands. Active on a TTY,
  // or force it for piped/automated input with CONSOLE=1.
  if (process.stdin.isTTY || process.env.CONSOLE === '1') {
    startConsole(clients, serverList, plugins);
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
