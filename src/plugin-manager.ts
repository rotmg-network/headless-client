import { Client } from './client';
import { Plugin, PLUGINS } from './plugins';

/**
 * Loads plugins onto clients and tracks them per client, so a client's plugins
 * are independent and can be unloaded at runtime.
 */
export class PluginManager {
  private readonly byClient = new Map<Client, Map<string, Plugin>>();

  /** Instantiates and attaches a plugin to a client. Returns false if unknown. */
  load(client: Client, name: string): boolean {
    const PluginClass = PLUGINS[name];
    if (!PluginClass) {
      console.warn(`[${client.alias}] unknown plugin: ${name}`);
      return false;
    }
    let loaded = this.byClient.get(client);
    if (!loaded) {
      loaded = new Map();
      this.byClient.set(client, loaded);
    }
    if (loaded.has(name)) {
      return true; // already loaded
    }
    const plugin = new PluginClass();
    plugin.attach(client);
    loaded.set(name, plugin);
    console.log(`[${client.alias}] plugin loaded: ${name}`);
    return true;
  }

  /** Detaches a plugin from a client. */
  unload(client: Client, name: string): boolean {
    const plugin = this.byClient.get(client)?.get(name);
    if (!plugin) {
      return false;
    }
    plugin.detach?.();
    this.byClient.get(client)?.delete(name);
    console.log(`[${client.alias}] plugin unloaded: ${name}`);
    return true;
  }

  /** Plugins currently loaded on a client. */
  loaded(client: Client): string[] {
    return [...(this.byClient.get(client)?.keys() ?? [])];
  }

  /** All registered plugin names. */
  available(): string[] {
    return Object.keys(PLUGINS);
  }
}
