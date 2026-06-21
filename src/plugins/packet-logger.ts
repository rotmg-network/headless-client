import { DeathPacket, GlobalNotificationPacket, NotificationPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { Plugin, PacketHook, EventHook } from './decorators';

/**
 * Logs notable server-pushed events: notifications, global announcements, and
 * deaths. Demonstrates hooking several packet types plus a game event.
 */
@Plugin({
  name: 'PacketLogger',
  description: 'Logs server notifications, announcements, and deaths.',
  author: 'realmlib',
  version: '1.0.0',
})
export class PacketLogger {
  @PacketHook()
  onNotification(client: Client, p: NotificationPacket): void {
    if (p.message) {
      console.log(`[${client.alias}] notification(${p.effect}): ${p.message}\n${p}`);
    }
  }

  @PacketHook()
  onGlobalNotification(client: Client, p: GlobalNotificationPacket): void {
    console.log(`[${client.alias}] announcement(${p.notificationType}): ${p.text}`);
  }

  @EventHook(ClientEvent.Death)
  onDeath(client: Client, p: DeathPacket): void {
    console.log(`[${client.alias}] DEATH: ${p.accountId} killed by ${p.killedBy} (${p.fameEarned} fame)`);
  }
}
