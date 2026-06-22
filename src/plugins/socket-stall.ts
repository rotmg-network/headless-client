import { ExaltationUpdatePacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { EventHook, PacketHook, Plugin } from './decorators';

const DEFAULT_STALL_MS = 5000;
const POLL_MS = 200;

/**
 * Measures the server's tolerance for a stalled connection — the legitimate
 * "lag protection" behaviour where a client that goes quiet is held rather than
 * flooded with enemy shots. It pauses the socket for a configurable window,
 * then resumes, and reports whether the server kept the session alive or
 * dropped it. Useful for tuning reconnect/keep-alive logic.
 *
 * It deliberately does nothing else during the stall — no inventory or
 * character-state changes — so it can only ever measure timing, never exploit
 * a desync. Trigger from the console with `stalltest <alias> [ms]`.
 */
@Plugin({
  name: 'SocketStall',
  description: 'Stalls the socket for N ms to measure how long the server tolerates silence before dropping you.',
  author: 'realmlib',
  version: '1.0.0',
})
export class SocketStall {
  private running = false;
  private droppedDuringStall = false;

  /** Notes if the connection died while we were stalled. */
  @EventHook(ClientEvent.Disconnect)
  onDisconnect(client: Client): void {
    if (this.running) {
      this.droppedDuringStall = true;
      console.warn(`[${client.alias}] SocketStall: server dropped the connection during the stall`);
    }
  }

  @PacketHook()
  onExaltUpdate(client: Client, p: ExaltationUpdatePacket): void {
    //console.log(`[${client.alias}] SocketStall: starting stall for ${DEFAULT_STALL_MS}`);
    //this.run(client);
  }

  /** Stalls the socket for `ms`, then resumes and reports the outcome. */
  async run(client: Client, ms = DEFAULT_STALL_MS): Promise<void> {
    if (this.running) {
      console.log(`[${client.alias}] SocketStall: already running`);
      return;
    }
    this.running = true;
    this.droppedDuringStall = false;
    try {
      if (!client.stallSocket()) {
        console.warn(`[${client.alias}] SocketStall: could not stall (not connected, or already stalled)`);
        return;
      }
      console.log(`[${client.alias}] SocketStall: holding for ${ms}ms…`);

      // Wait the window out, but bail early if the server drops us first.
      const started = Date.now();
      while (Date.now() - started < ms && !this.droppedDuringStall) {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      if (this.droppedDuringStall) {
        console.log(
          `[${client.alias}] SocketStall: server tolerance < ${Date.now() - started}ms — it dropped us before resume`,
        );
        return;
      }

      const heldMs = client.resumeSocket();
      console.log(
        `[${client.alias}] SocketStall: resumed after ${heldMs}ms — connection survived; ` +
          `watch the next few ticks for whether the server backfills or kicks us`,
      );
    } finally {
      this.running = false;
    }
  }
}
