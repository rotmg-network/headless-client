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
usually `(client: Client, packet: SomePacket)`. A hook can also accept a third
`PacketContext` argument and call `ctx.cancel()` to stop lower-priority hooks
for that packet:

```ts
@PacketHook()
onUpdate(client: Client, update: UpdatePacket): void { ... }   // hooks UPDATE

@PacketHook({ priority: 100 })
onText(client: Client, text: TextPacket, ctx: PacketContext): void {
  if (isSpam(text.text)) {
    ctx.cancel('spam');
  }
}
```

Subscribing is what makes realmlib start parsing that packet type for the
client, and the hook survives reconnects automatically. Higher priority hooks
run first; hooks with the same priority run in load order. Cancelling a packet
only stops later plugin hooks for that packet type; it does not undo network
receipt or skip the client's required protocol acknowledgements.

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
- `client.usePortal(objectId)` — use a tracked portal object
- `client.swapInventorySlots(fromSlotId, toSlotId)` — send `INVSWAP` for player slots
- `client.shootAt({ x, y })` — aim and send `PLAYERSHOOT` at a world position

Queries:

- `client.alias`
- `client.getPlayer()` — parsed `PlayerData`
- `client.getPosition()` / `client.getObjectId()` / `client.isInVault()`
- `client.getServerHost()` / `client.knownServers()` / `client.differentServer()`
- `client.visibleObjects()` — tracked non-player objects from updates
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
| `AntiSpam` | high-priority cancellable `@PacketHook` before chat logging |
| `AutoQuest` | realm entry, `QUESTOBJID` tracking, movement, and basic auto-shooting |
| `PacketLogger` | several `@PacketHook`s + an `@EventHook` (Death) |
| `AutoVault` | `@EventHook`s driving a command (`enterVault`) |
| `RealmFinder` | reading `realmPortals()` from an event hook; pure selection logic |
| `RealmHostMapper` | multi-step event/packet workflow: visit portals, record Reconnect hosts, escape back |
| `game-id-checker` | controlled live probing of known and candidate `Hello.gameId` values |
| `ChestReplication` | test-server inventory/backpack sync diagnostic across Bazaar/server transitions |

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

### `ChestReplication`

`ChestReplication` is intentionally gated for test infrastructure. It refuses to
run unless the current server host appears in `CHEST_REPLICATION_TEST_HOSTS`.
The workflow enters a Bazaar portal, checks regular inventory slots `4-11` and
backpack slots `12-19`, moves backpack items into empty inventory slots when
regular inventory is empty, switches to a different allowlisted server, repeats
the check, then enters Bazaar again and reports whether tracked items are present
in both containers.

Required:

| var | meaning |
|-----|---------|
| `CHEST_REPLICATION_TEST_HOSTS=host1,host2` | comma-separated test-server allowlist |

Optional:

| var | meaning |
|-----|---------|
| `CHEST_REPLICATION_NEXT_SERVER=host2` | explicit second test server by host or server name |
| `CHEST_REPLICATION_BAZAAR=LeftBazaar` | preferred portal; use `RightBazaar` or `any` as needed |
| `CHEST_REPLICATION_CHECK_DELAY_MS=5000` | delay before each inventory/backpack snapshot |
| `CHEST_REPLICATION_MOVE_SETTLE_MS=2500` | delay after `INVSWAP`s before continuing |

### `AutoQuest`

`AutoQuest` waits for Nexus realm portals, walks to the least-populated open
portal, enters it, listens for `QUESTOBJID`, and repeatedly walks toward the
visible quest object. While questing it aims at nearby tracked objects that are
not known player classes or portal types.

Optional environment variables:

| var | meaning |
|-----|---------|
| `AUTO_QUEST_SHOOT_RANGE=6` | max tile distance for auto-shoot targets |
| `AUTO_QUEST_SHOOT_INTERVAL_MS=450` | delay between shooting bursts |
| `AUTO_QUEST_MAX_SHOTS=3` | max nearby targets aimed at per burst |
| `AUTO_QUEST_REFRESH_MS=1200` | delay between quest movement target refreshes |

Current limitation: enemy detection is packet-state based until object metadata
is loaded into the client. The plugin filters out known player classes and
portals, then treats the remaining nearby tracked objects as shootable.
