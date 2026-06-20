import 'reflect-metadata';
import { Packet, PacketType } from 'realmlib';
import { ClientEvent } from '../events';

/** Metadata describing a plugin, set via the `@Plugin({...})` decorator. */
export interface PluginInfo {
  /** Unique name used to load the plugin (from accounts.json or the console). */
  name: string;
  /** What the plugin does. */
  description: string;
  /** Plugin author. */
  author?: string;
  /** Plugin version. */
  version?: string;
  /** If false, the plugin is registered but not auto-loaded. Defaults to true. */
  enabled?: boolean;
}

/** Any class usable as a plugin (instantiated once per client). */
export type PluginClass = new () => object;

interface PacketHookDef {
  method: string;
  packetType: PacketType;
  priority: number;
}
interface EventHookDef {
  method: string;
  event: ClientEvent;
}

const byName = new Map<string, PluginClass>();
const infos = new Map<PluginClass, PluginInfo>();
const packetHooks = new Map<PluginClass, PacketHookDef[]>();
const eventHooks = new Map<PluginClass, EventHookDef[]>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/**
 * Marks a class as a plugin and registers it under `info.name`.
 */
export function Plugin(info: PluginInfo): ClassDecorator {
  return (target) => {
    const cls = target as unknown as PluginClass;
    infos.set(cls, { enabled: true, ...info });
    byName.set(info.name, cls);
  };
}

/**
 * Options for packet hooks. Higher priority hooks run first; a hook can cancel
 * the packet context to stop lower-priority hooks from seeing it.
 */
export interface PacketHookOptions {
  priority?: number;
}

/**
 * Hooks an incoming packet. The packet type is inferred from the method's
 * second parameter type — e.g. `onText(client: Client, text: TextPacket)`
 * hooks PacketType.TEXT. Subscribing makes realmlib parse that type.
 */
export function PacketHook(options: PacketHookOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    const params: unknown[] = Reflect.getMetadata('design:paramtypes', target, propertyKey) ?? [];
    const packetClass = params[1] as (new () => Packet) | undefined;
    if (!packetClass) {
      console.warn(`@PacketHook on ${String(propertyKey)} needs a (client, packet) signature`);
      return;
    }
    let packetType: PacketType;
    try {
      packetType = new packetClass().type;
    } catch {
      console.warn(`@PacketHook: could not resolve a packet type for ${String(propertyKey)}`);
      return;
    }
    push(packetHooks, (target as object).constructor as PluginClass, {
      method: propertyKey as string,
      packetType,
      priority: options.priority ?? 0,
    });
  };
}

/**
 * Hooks a game event (see `ClientEvent`). The method receives the client
 * followed by the event payload, e.g. `(client, vault: VaultContentPacket)`.
 */
export function EventHook(event: ClientEvent): MethodDecorator {
  return (target, propertyKey) => {
    push(eventHooks, (target as object).constructor as PluginClass, { method: propertyKey as string, event });
  };
}

export function getPluginClass(name: string): PluginClass | undefined {
  return byName.get(name);
}
export function getPluginInfo(cls: PluginClass): PluginInfo | undefined {
  return infos.get(cls);
}
export function allPluginInfos(): PluginInfo[] {
  return [...infos.values()];
}
export function getPacketHooks(cls: PluginClass): PacketHookDef[] {
  return packetHooks.get(cls) ?? [];
}
export function getEventHooks(cls: PluginClass): EventHookDef[] {
  return eventHooks.get(cls) ?? [];
}
