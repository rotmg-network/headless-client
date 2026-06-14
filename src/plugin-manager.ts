import { Packet } from 'realmlib';
import { Client } from './client';
import { allPluginInfos, getEventHooks, getPacketHooks, getPluginClass } from './plugins';

interface Binding {
  event: string;
  fn: (...args: unknown[]) => void;
}

interface Loaded {
  instance: object;
  bindings: Binding[];
}

/**
 * Loads plugins onto clients by wiring their decorated `@PacketHook` /
 * `@EventHook` methods to the client's hooks, and tracks the wiring so a
 * plugin can be cleanly unloaded. Plugins are instantiated once per client,
 * so each client's plugins have independent state.
 */
export class PluginManager {
  private readonly byClient = new Map<Client, Map<string, Loaded>>();

  /** Instantiates a plugin and wires its hooks to the client. */
  load(client: Client, name: string): boolean {
    const cls = getPluginClass(name);
    if (!cls) {
      console.warn(`[${client.alias}] unknown plugin: ${name}`);
      return false;
    }
    let clientPlugins = this.byClient.get(client);
    if (!clientPlugins) {
      clientPlugins = new Map();
      this.byClient.set(client, clientPlugins);
    }
    if (clientPlugins.has(name)) {
      return true; // already loaded
    }

    const instance = new cls() as Record<string, (...args: unknown[]) => void>;
    const bindings: Binding[] = [];

    for (const hook of getPacketHooks(cls)) {
      const fn = (packet: Packet): void => instance[hook.method](client, packet);
      client.onPacket(hook.packetType, fn);
      bindings.push({ event: hook.packetType, fn: fn as (...args: unknown[]) => void });
    }
    for (const hook of getEventHooks(cls)) {
      const fn = (...args: unknown[]): void => instance[hook.method](client, ...args);
      client.on(hook.event, fn);
      bindings.push({ event: hook.event, fn });
    }

    clientPlugins.set(name, { instance, bindings });
    console.log(`[${client.alias}] plugin loaded: ${name}`);
    return true;
  }

  /** Removes a plugin's hooks from the client. */
  unload(client: Client, name: string): boolean {
    const loaded = this.byClient.get(client)?.get(name);
    if (!loaded) {
      return false;
    }
    for (const binding of loaded.bindings) {
      client.off(binding.event, binding.fn);
    }
    this.byClient.get(client)?.delete(name);
    console.log(`[${client.alias}] plugin unloaded: ${name}`);
    return true;
  }

  /** Plugins currently loaded on a client. */
  loaded(client: Client): string[] {
    return [...(this.byClient.get(client)?.keys() ?? [])];
  }

  /** All registered plugins (name + description). */
  available(): { name: string; description: string }[] {
    return allPluginInfos().map((info) => ({ name: info.name, description: info.description }));
  }
}
