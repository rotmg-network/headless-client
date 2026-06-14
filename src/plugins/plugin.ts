import { Client } from '../client';

/**
 * A plugin is instantiated once per client (so it can hold per-client state)
 * and wired up via attach(). Register packet hooks (`client.onPacket(...)`) and
 * game-event hooks (`client.on(...)`) there. Implement detach() to remove those
 * hooks if you want the plugin to be unloadable at runtime.
 */
export interface Plugin {
  attach(client: Client): void;
  detach?(): void;
}
