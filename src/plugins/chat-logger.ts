import { PacketType, TextPacket } from 'realmlib';
import { Client } from '../client';
import { Plugin } from './plugin';

/**
 * Logs in-game chat. Demonstrates hooking a raw packet — subscribing makes
 * realmlib start parsing TEXT packets for this client.
 */
export class ChatLogger implements Plugin {
  private client: Client | undefined;

  private readonly onText = (p: TextPacket): void => {
    if (p.text) {
      console.log(`[${this.client?.alias}] <${p.name}> ${p.text}`);
    }
  };

  attach(client: Client): void {
    this.client = client;
    client.onPacket(PacketType.TEXT, this.onText);
  }

  detach(): void {
    this.client?.off(PacketType.TEXT, this.onText);
  }
}
