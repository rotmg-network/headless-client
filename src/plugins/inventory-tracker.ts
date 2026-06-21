import { InvResultPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { EventHook, PacketHook, Plugin } from './decorators';

/**
 * Passive inventory observer. It keeps a local copy of the player's 20 item
 * slots and, every tick, diffs it against what the server reports — logging
 * every change with a timestamp and flagging anything that looks like a server
 * bug (an item silently vanishing to an empty slot with no corresponding move).
 *
 * It also logs every INVRESULT the server sends, so you can measure the latency
 * and outcome of inventory operations and see when the server's idea of a slot
 * disagrees with what we asked for. Purely observational — it never sends
 * anything. Use it alongside PetBagRoundTrip to measure void/dedup behaviour.
 *
 * Slot layout: 0-3 equipment, 4-11 inventory, 12-19 backpack.
 */
@Plugin({
  name: 'InventoryTracker',
  description: 'Tracks inventory slots, logs every server change, flags unexpected item voids.',
  author: 'realmlib',
  version: '1.0.0',
})
export class InventoryTracker {
  private last: number[] | undefined;
  private changeCount = 0;
  private voidCount = 0;

  /** Resets the model on each map entry — slots are re-sent fresh after a load. */
  @EventHook(ClientEvent.MapChange)
  onMapChange(): void {
    this.last = undefined;
  }

  /** Diffs the live inventory against the previous snapshot once per tick. */
  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    const current = client.getInventory();
    if (!current) {
      return;
    }
    if (!this.last) {
      this.last = current;
      return;
    }
    for (let slot = 0; slot < current.length; slot++) {
      const before = this.last[slot] ?? -1;
      const after = current[slot] ?? -1;
      if (before === after) {
        continue;
      }
      this.changeCount++;
      const where = InventoryTracker.slotLabel(slot);
      if (before !== -1 && after === -1) {
        // Item left a slot with nothing taking its place. Normal for a move
        // (the other half of the swap shows up elsewhere this same tick) but
        // worth surfacing — a lone disappearance is the classic server void.
        this.voidCount++;
        console.warn(
          `[${client.alias}] InventoryTracker: ${where} (slot ${slot}) item ${before} → EMPTY ` +
            `(possible void #${this.voidCount}; confirm a paired arrival elsewhere this tick)`,
        );
      } else {
        console.log(
          `[${client.alias}] InventoryTracker: ${where} (slot ${slot}) ${before === -1 ? 'EMPTY' : before} → ${after === -1 ? 'EMPTY' : after}`,
        );
      }
    }
    this.last = current;
  }

  /** Logs the server's response to an inventory operation. */
  @PacketHook()
  onInvResult(client: Client, packet: InvResultPacket): void {
    console.log(
      `[${client.alias}] InventoryTracker: INVRESULT ok=${packet.unknownBool} byte=${packet.unknownByte} ` +
        `from(obj ${packet.fromSlot.objectId} slot ${packet.fromSlot.slotId} type ${signed(packet.fromSlot.objectType)}) ` +
        `to(obj ${packet.toSlot.objectId} slot ${packet.toSlot.slotId} type ${signed(packet.toSlot.objectType)})`,
    );
  }

  /** Current counters for console inspection / tests. */
  status(): { changes: number; voids: number } {
    return { changes: this.changeCount, voids: this.voidCount };
  }

  /** Human label for a slot index. */
  static slotLabel(slot: number): string {
    if (slot <= 3) {
      return 'equip';
    }
    if (slot <= 11) {
      return 'inventory';
    }
    return 'backpack';
  }
}

/** Renders the 0xffffffff "empty" sentinel as -1. */
function signed(objectType: number): number {
  return objectType === 0xffffffff ? -1 : objectType;
}
