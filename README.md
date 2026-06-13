# headless-client

A headless (clientless) Realm of the Mad God client built on top of
[realmlib](../realmlib) for the wire protocol. It logs in through the AppEngine,
completes the `Hello` handshake, and runs the keep-alive loop so an account
connects and stays in-world — no game client required.

## How it works

1. **Login** (`src/account-service.ts`) — `POST /account/verify` with a Unity
   user-agent to get an access token, then `POST /char/list` for the character
   and server list.
2. **Connect** (`src/client.ts`) — open a TCP socket to the chosen server and
   hand it to realmlib's `PacketIO`, which handles framing + RC4.
3. **Handshake** — send `Hello` (build version + access token + tokens).
4. **Keep-alive** — reply to `NewTick` with `Move`, `Ping` with `Pong`,
   `Update` with `UpdateAck`, and shoots with `ShootAck`.

The numeric packet-id map for the current build lives in `src/packet-map.ts`.

## Setup

```bash
npm install
cp accounts.example.json accounts.json   # then fill in real credentials
npm start
```

`accounts.json` is gitignored — credentials never get committed.

To run for a fixed duration (useful for testing), set `RUN_SECONDS`:

```bash
RUN_SECONDS=30 npm start
```

## Status

Early connection spike. Next: game-state tracking, a plugin/hook system
(modeled on nrelay), reconnect/proxy handling, and multi-account support.
