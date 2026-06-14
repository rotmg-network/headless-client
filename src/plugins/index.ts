import { Plugin } from './plugin';
import { AutoVault } from './auto-vault';
import { ChatLogger } from './chat-logger';

export type PluginClass = new () => Plugin;

/**
 * The plugin registry: name -> class. Add new plugins here so they can be
 * referenced by name from accounts.json or the console.
 */
export const PLUGINS: Record<string, PluginClass> = {
  AutoVault,
  ChatLogger,
};

export { Plugin };
