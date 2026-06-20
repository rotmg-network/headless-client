# headless-client

A **headless (clientless) Realm of the Mad God client** built on top of
[realmlib](../realmlib) for the wire protocol. It logs in through the official
AppEngine, completes the `Hello` handshake, and runs the keep-alive loop so an
account connects and stays in-world — **no game client required**.

On top of that base it adds a decorator-based **plugin system**, vault and realm
navigation, and a small runtime console for driving connected clients. It's
intended for protocol exploration, automation, and bot-framework groundwork.

## How it works

1. **Login** (`src/account-service.ts`) — `POST /account/verify` with a Unity
   user-agent to get an access token, then `POST /char/list` for the character
   and server list. Tokens are cached in `.token-cache.json` (gitignored) and
   reused until they expire, so `/account/verify` is only hit when needed.
2. **Connect** (`src/client.ts`) — open a TCP socket to the chosen server
   (port 2050) and hand it to realmlib's `PacketIO`, which handles the
   `[length][id][RC4 body]` framing and encryption.
3. **Handshake** — send `Hello` (build version + access token + client tokens).
4. **Keep-alive** — reply to `NewTick` with `Move`, `Ping` with `Pong`,
   `Update` with `UpdateAck`, and enemy/ally shoots with `ShootAck`. Balanced
   ack/move counts are what keep the connection from being dropped.

The numeric packet-id map and packet structures live in realmlib
(`DEFAULT_PACKET_MAP`); the client never redefines protocol details. realmlib is
reconciled to the current build (6.11) and round-trip tested.

## Setup

```bash
npm install
cp accounts.example.json accounts.json   # then fill in real credentials
npm start
```

`accounts.json` and `.token-cache.json` are **gitignored** — secrets never get
committed.

### `accounts.json` format

An array of account objects:

```json
[
  {
    "guid": "you@example.com",
    "password": "hunter2",
    "alias": "main",
    "enterVault": false,
    "plugins": ["ChatLogger", "RealmFinder"]
  }
]
```

| field | required | meaning |
|-------|----------|---------|
| `guid` | yes | account email |
| `password` | yes | account password |
| `alias` | no | short name used in logs and console commands (defaults to `guid`) |
| `enterVault` | no | walk to the vault automatically after entering the nexus |
| `plugins` | no | plugin names to load for this account on connect |

Multiple accounts are spread across distinct servers automatically to avoid
per-server limits. **Note:** running several accounts from one IP trips RotMG's
abuse detection — multi-account needs per-account proxies (not yet implemented).

## Running

```bash
npm start            # connect every account in accounts.json
npm run build        # type-check / compile to JS
```

### Environment variables

| var | effect |
|-----|--------|
| `RUN_SECONDS=30` | auto-exit after N seconds (handy for short test runs) |
| `LOGIN_ONLY=1` | exercise auth + `/char/list` only — no socket, no account lock |
| `CONSOLE=1` | force the interactive console even when stdin isn't a TTY |
| `DEBUG_PACKETS=types` | log every incoming packet type |
| `DEBUG_PACKETS=hex` | log each type and hexdump its payload |
| `DEBUG_PACKETS=unknown` | log + hexdump only unmapped packet ids |
| `GAME_ID_CHECK_EXTRA=-20:-14,-12` | extra game ids/ranges for `game-id-checker` to probe |
| `GAME_ID_CHECK_DELAY_MS=5000` | delay between `game-id-checker` reconnect attempts |
| `GAME_ID_CHECK_TIMEOUT_MS=20000` | per-id timeout before `game-id-checker` marks a probe failed |
| `CHEST_REPLICATION_TEST_HOSTS=host1,host2` | required allowlist for `ChestReplication` test-server runs |
| `CHEST_REPLICATION_NEXT_SERVER=host2` | optional explicit second test server for `ChestReplication` |
| `CHEST_REPLICATION_BAZAAR=LeftBazaar` | preferred Bazaar portal (`LeftBazaar`, `RightBazaar`, or `any`) |

Unmapped packet ids are always reported once even without `DEBUG_PACKETS`.

### Interactive console

When attached to a TTY (or with `CONSOLE=1`), a stdin console is available:

| command | action |
|---------|--------|
| `show` | print the current runtime config |
| `set <key> <value>` | change a config field (e.g. `set rateLimitReconnectMs 60000`) |
| `vault <alias>` | tell a client to walk into the vault |
| `escape <alias>` | send the client back to the nexus |
| `connect <alias> <server>` | connect a client to a server (name or host) |
| `realms <alias>` | list the realm portals a client can see |
| `hosts <alias>` | list RealmHostMapper portal details, including resolved hostnames |
| `gameids <alias>` | list `game-id-checker` results |
| `plugins <alias>` | list loaded + available plugins |
| `plugin <alias> load\|unload <name>` | load/unload a plugin at runtime |

## Plugins

Behaviour is added via decorator-based plugins that hook packets and game
events — no edits to `client.ts`. Set `"plugins": ["ChatLogger"]` on an account,
or load at runtime with `plugin <alias> load <name>`. See
[docs/PLUGINS.md](docs/PLUGINS.md) for the authoring guide.

Bundled examples:

| plugin | demonstrates |
|--------|--------------|
| `ChatLogger` | a single `@PacketHook` (TEXT) |
| `PacketLogger` | several `@PacketHook`s + an `@EventHook` (Death) |
| `AutoVault` | `@EventHook`s driving a command (`enterVault`) |
| `RealmFinder` | reading `realmPortals()`; pure, unit-testable selection logic |
| `RealmHostMapper` | walking each realm portal, capturing its Reconnect host, and returning to Nexus |
| `game-id-checker` | probing known and candidate `Hello.gameId` values for valid maps |
| `ChestReplication` | test-server inventory/backpack sync verification across Bazaar and server transitions |

## Status

Working clientless client + plugin system, reconciled to build 6.11.
Next up: SOCKS proxy support for multi-account, fuller game-state/entity
tracking, and a client-side test suite.

## Credits

This project would not exist without these reference implementations:

- **[pyrelay](https://github.com/Maxi35/pyrelay)** — a current, working Python
  headless client. The authoritative source for the login flow, `Hello` field
  order, packet ids, and packet structures; realmlib's protocol layer was
  reconciled against it.
- **[nrelay](https://github.com/thomas-crane/nrelay)** — a TypeScript clientless
  framework. Architectural reference for the runtime, the plugin/hook system,
  account handling, and proxy support.
- **[RealmShark](https://github.com/X-com/RealmShark)** — a Java pcap sniffer,
  used to cross-check current packet structures and data types.
- **[realmlib](../realmlib)** — the wire-protocol library this client is built
  on (originally derived from the realmlib/nrelay lineage, hardened and
  reconciled here).

Realm of the Mad God is a trademark of its respective owners. This project is an
independent, educational protocol implementation and is not affiliated with or
endorsed by them.
