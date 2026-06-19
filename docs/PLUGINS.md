# Writing plugins

Plugins add behaviour to a client by hooking **packets** and **game events**.
A plugin is a class instantiated **once per client**, so each client gets its
own plugin instances and state. Hooks are declared with decorators — no
boilerplate, no edits to `client.ts`.

## Quick start

```ts
// src/plugins/hello.ts
import { TextPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { Plugin, PacketHook, EventHook } from './decorators';

@Plugin({ name: 'Hello', description: 'Greets on entry and echoes chat.' })
export class Hello {
  @EventHook(ClientEvent.Ready)
  onReady(client: Client): void {
    console.log(`${client.alias} is in-world`);
  }

  @PacketHook()
  onText(client: Client, text: TextPacket): void {
    console.log(`<${text.name}> ${text.text}`);
  }
}
```

Then:

1. Register it — add `import './hello';` to `src/plugins/index.ts`.
2. Load it — list it on an account in `accounts.json`
   (`"plugins": ["Hello"]`), or at runtime with `plugin <alias> load Hello`.

## Decorators

### `@Plugin({ ... })`
Class decorator. Registers the plugin under `name` and attaches its metadata.

| field | required | meaning |
|-------|----------|---------|
| `name` | yes | unique id used to load the plugin |
| `description` | yes | shown in the console `plugins` table |
| `author` | no | |
| `version` | no | |
| `enabled` | no | metadata flag (defaults to true) |

### `@PacketHook()`
Method decorator for an incoming packet. The packet type is **inferred from the
method's second parameter type** — no need to name it. The method signature is
always `(client: Client, packet: SomePacket)`:

```ts
@PacketHook()
onUpdate(client: Client, update: UpdatePacket): void { ... }   // hooks UPDATE
```

Subscribing is what makes realmlib start parsing that packet type for the
client, and the hook survives reconnects automatically.

### `@EventHook(ClientEvent.X)`
Method decorator for a higher-level game event. The method receives the client
followed by the event payload:

```ts
@EventHook(ClientEvent.VaultContents)
onVault(client: Client, vault: VaultContentPacket): void { ... }
```

## Game events (`ClientEvent`)

| event | payload |
|-------|---------|
| `Connected` | — |
| `Ready` | `objectId: number` (in-world) |
| `MapChange` | `name: string` |
| `EnterVault` / `EnterNexus` | — |
| `VaultContents` | `VaultContentPacket` |
| `RealmPortal` | `RealmPortal` |
| `Tick` | `PlayerData \| undefined` |
| `Death` | `DeathPacket` |
| `Failure` | `FailurePacket` |
| `Disconnect` | — |
| `ReachedTarget` | `{ x, y }` |

## What a plugin can do with the client

Commands:

- `client.send(packet)` — send any packet
- `client.moveTo({ x, y })` — walk to a position (emits `ReachedTarget`)
- `client.enterVault()` / `client.escape()` — vault / nexus
- `client.connectToServer(host)` — switch servers
- `client.connectToGameId(gameId, host?)` — reconnect to a specific Hello game id

Queries:

- `client.alias`
- `client.getPlayer()` — parsed `PlayerData`
- `client.getPosition()` / `client.getObjectId()` / `client.isInVault()`
- `client.realmPortals()` — tracked realm portals

You can also subscribe directly with `client.on(ClientEvent.X, fn)` /
`client.onPacket(PacketType.X, fn)` if you need to outside of decorators.

## Loading / unloading

- **Config:** add the plugin name to an account's `plugins` array in
  `accounts.json`. It loads when that client connects.
- **Runtime console:**
  - `plugins <alias>` — list loaded plugins + all available (name + description)
  - `hosts <alias>` — print `RealmHostMapper`'s portal -> hostname table
  - `gameids <alias>` — print `game-id-checker` probe results
  - `plugin <alias> load <name>`
  - `plugin <alias> unload <name>` — removes all its hooks cleanly

## Bundled examples

| plugin | shows |
|--------|-------|
| `ChatLogger` | a single `@PacketHook` (TEXT) |
| `PacketLogger` | several `@PacketHook`s + an `@EventHook` (Death) |
| `AutoVault` | `@EventHook`s driving a command (`enterVault`) |
| `RealmFinder` | reading `realmPortals()` from an event hook; pure selection logic |
| `RealmHostMapper` | multi-step event/packet workflow: visit portals, record Reconnect hosts, escape back |
| `game-id-checker` | controlled live probing of known and candidate `Hello.gameId` values |

### `game-id-checker`

Load `"game-id-checker"` on one account to probe every known `GameId` plus the
currently undocumented gaps between `-13` and `-1`. It records whether each id
reaches `MapInfo` and whether it fully loads into the world with
`CreateSuccess`.

Optional environment variables:

| var | meaning |
|-----|---------|
| `GAME_ID_CHECK_EXTRA=-50:-14,0,1` | additional ids/ranges to probe |
| `GAME_ID_CHECK_DELAY_MS=5000` | delay between reconnect attempts |
| `GAME_ID_CHECK_TIMEOUT_MS=20000` | per-id timeout before a probe is marked failed |
