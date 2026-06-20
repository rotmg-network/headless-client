import { TextPacket } from 'realmlib';
import { Client, PacketContext } from '../client';
import { Plugin, PacketHook } from './decorators';

const SPAM_MARKERS = [
  'realm i stock i com',
  'r0tmg ar$3nal',
  'r0tmg-ar$3nal',
  'r0tmgar$3nal',
  'rotmg ar$3nal',
  'r.e.a.i.m.s.h.o.p',
  '========',
];

/** Blocks spam messages received in incoming TEXT packets. */
@Plugin({
  name: 'AntiSpam',
  description: 'Simple anti-spam to block spam bots.',
  author: 'realmlib',
  version: '1.0.0',
})
export class AntiSpam {
  @PacketHook({ priority: 100 })
  onText(_client: Client, text: TextPacket, ctx: PacketContext): void {
    if (this.isSpam(text.text)) {
      ctx.cancel('spam text');
    }
  }

  private isSpam(message: string): boolean {
    const normalized = message.toLowerCase();
    return SPAM_MARKERS.some((marker) => normalized.includes(marker));
  }
}
