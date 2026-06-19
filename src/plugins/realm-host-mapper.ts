import { ReconnectPacket, UsePortalPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { RealmPortal } from '../models';
import { EventHook, PacketHook, Plugin } from './decorators';

interface PortalRecord extends RealmPortal {
  /** Hostname/address supplied by the server when entering this realm. */
  hostname?: string;
  /** Reconnect packet display/name field, if any. */
  reconnectName?: string;
  /** Game id supplied by the realm reconnect. */
  gameId?: number;
}

type MapperState = 'idle' | 'scanningNexus' | 'walkingToPortal' | 'awaitingReconnect' | 'awaitingRealmMap' | 'returningToNexus' | 'complete';

/**
 * Visits every visible realm portal in the Nexus and records the reconnect host
 * the server returns for each one.
 */
@Plugin({
  name: 'RealmHostMapper',
  description: 'Enters each visible realm portal and records the realm host for the current Nexus server.',
  author: 'realmlib',
  version: '1.0.0',
})
export class RealmHostMapper {
  private state: MapperState = 'idle';
  private readonly records = new Map<string, PortalRecord>();
  private currentKey: string | undefined;
  private currentPortal: PortalRecord | undefined;
  private lastSummary = '';

  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    if (this.state === 'idle') {
      this.state = 'scanningNexus';
      console.log(`[${client.alias}] RealmHostMapper: scanning Nexus realm portals`);
    } else if (this.state === 'returningToNexus' || this.state === 'awaitingRealmMap') {
      this.state = 'scanningNexus';
      this.currentKey = undefined;
      this.currentPortal = undefined;
    }
    this.step(client);
  }

  @EventHook(ClientEvent.RealmPortal)
  onRealmPortal(client: Client, portal: RealmPortal): void {
    this.upsert(portal);
    this.step(client);
  }

  @EventHook(ClientEvent.ReachedTarget)
  onReachedTarget(client: Client): void {
    if (this.state !== 'walkingToPortal' || !this.currentPortal) {
      return;
    }
    const portal = this.currentPortal;
    this.state = 'awaitingReconnect';
    console.log(`[${client.alias}] RealmHostMapper: entering ${portal.name} (${portal.players}/${portal.maxPlayers})`);

    // Let the current tick's MOVE go out first so the server sees us at the portal.
    setTimeout(() => {
      const use = new UsePortalPacket();
      use.objectId = portal.objectId;
      client.send(use);
    }, 0);
  }

  @PacketHook()
  onReconnect(client: Client, packet: ReconnectPacket): void {
    if (this.state !== 'awaitingReconnect' || !this.currentKey) {
      return;
    }
    const record = this.records.get(this.currentKey);
    if (!record) {
      return;
    }
    record.hostname = packet.host;
    record.reconnectName = packet.name;
    record.gameId = packet.gameId;
    this.state = 'awaitingRealmMap';
    console.log(`[${client.alias}] RealmHostMapper: ${record.name} -> ${packet.host} (gameId ${packet.gameId})`);
  }

  @EventHook(ClientEvent.MapChange)
  onMapChange(client: Client, mapName: string): void {
    if (this.state !== 'awaitingRealmMap') {
      return;
    }
    if (mapName === 'Nexus') {
      return;
    }
    this.state = 'returningToNexus';
    console.log(`[${client.alias}] RealmHostMapper: reached ${mapName}; escaping back to Nexus`);
    client.escape();
  }

  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    this.step(client);
  }

  /** All collected portal records, including hostnames once resolved. */
  portals(): PortalRecord[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private step(client: Client): void {
    if (this.state !== 'scanningNexus') {
      return;
    }

    for (const portal of client.realmPortals()) {
      this.upsert(portal);
    }

    const next = this.nextUnresolved();
    if (!next) {
      this.finish(client);
      return;
    }

    this.currentPortal = next;
    this.currentKey = this.key(next);
    this.state = 'walkingToPortal';
    console.log(`[${client.alias}] RealmHostMapper: walking to ${next.name} portal at (${next.x.toFixed(1)}, ${next.y.toFixed(1)})`);
    client.moveTo({ x: next.x, y: next.y });
  }

  private upsert(portal: RealmPortal): void {
    const key = this.key(portal);
    const previous = this.records.get(key);
    this.records.set(key, { ...previous, ...portal, hostname: previous?.hostname, reconnectName: previous?.reconnectName, gameId: previous?.gameId });
  }

  private nextUnresolved(): PortalRecord | undefined {
    return [...this.records.values()]
      .filter((portal) => !portal.hostname && portal.players < portal.maxPlayers)
      .sort((a, b) => a.openedAt - b.openedAt || a.name.localeCompare(b.name))[0];
  }

  private finish(client: Client): void {
    const rows = this.portals();
    const summary = rows.map((portal) => `${portal.name}:${portal.hostname ?? '?'}`).join('|');
    if (this.state === 'complete' && summary === this.lastSummary) {
      return;
    }
    this.state = 'complete';
    this.lastSummary = summary;
    console.log(`[${client.alias}] RealmHostMapper: complete (${rows.filter((p) => p.hostname).length}/${rows.length} portals resolved)`);
    console.table(
      rows.map((portal) => ({
        name: portal.name,
        players: `${portal.players}/${portal.maxPlayers}`,
        openedAt: portal.openedAt,
        objectId: portal.objectId,
        hostname: portal.hostname ?? '',
        gameId: portal.gameId ?? '',
      })),
    );
  }

  private key(portal: Pick<RealmPortal, 'name' | 'openedAt'>): string {
    return `${portal.name}:${portal.openedAt}`;
  }
}
