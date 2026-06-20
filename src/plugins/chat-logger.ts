import { TextPacket } from 'realmlib';
import { Client } from '../client';
import { Plugin, PacketHook } from './decorators';

/** Logs in-game chat by hooking the TEXT packet */
@Plugin({
  name: 'ChatLogger',
  description: 'Logs in-game chat messages.',
  author: 'realmlib',
  version: '1.0.0',
})
export class ChatLogger {
  @PacketHook()
  onText(client: Client, text: TextPacket): void {
    if (text.text) {
      const isPlayerMessage = text.numStars != 65535;
      if (isPlayerMessage) {
        console.log(`[${client.alias}] ⭐️ ${text.numStars} <${text.name}> ${text.text}`);
      } else {
        console.log(`[${client.alias}] ${text.name} ${text.text}`);
      }
    }
  }
}
