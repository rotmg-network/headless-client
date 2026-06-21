import { Client } from '../client';
import { Plugin } from './decorators';

const INVENTORY_SLOTS = [4, 5, 6, 7, 8, 9, 10, 11];
const BACKPACK_SLOTS = [12, 13, 14, 15, 16, 17, 18, 19];
const DEFAULT_TIMEOUT_MS = 4000;
const POLL_MS = 100;

interface ItemTrip {
  itemId: number;
  fromSlot: number;
  toSlot: number;
  forwardMs: number;
  forwardOk: boolean;
  backMs: number;
  backOk: boolean;
}

/**
 * Measures how the server handles moving items between two of the player's own
 * containers — main inventory (slots 4-11) and backpack (slots 12-19) — through
 * normal INVSWAP packets. For each item it times the round trip out to the
 * backpack and back, verifies the item actually landed where expected, and
 * reports any slot the server voided or left inconsistent.
 *
 * This is the honest version of an item-shuffle test: it observes the server's
 * container-move behaviour and timing. It does not hold the socket, touch the
 * seasonal flag, or do anything during a desync window. Trigger it from the
 * console with `invtest <alias>`.
 *
 * Note: this uses the backpack as the second container because it's part of the
 * player object and verifiable from the inventory stats. A real "pet bag" is a
 * separate container object with its own objectId; if you want to target that,
 * pass its objectId into a future variant — the timing/void logic is identical.
 */
@Plugin({
  name: 'PetBagRoundTrip',
  description: 'Round-trips items inventory↔backpack via INVSWAP, timing each and flagging voids.',
  author: 'realmlib',
  version: '1.0.0',
})
export class PetBagRoundTrip {
  private running = false;

  /** Runs one full round-trip test. Safe to call from the console. */
  async run(client: Client, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.running) {
      console.log(`[${client.alias}] PetBagRoundTrip: already running`);
      return;
    }
    if (!client.hasBackpack()) {
      console.warn(`[${client.alias}] PetBagRoundTrip: character has no backpack — nothing to test against`);
      return;
    }
    const start = client.getInventory();
    if (!start) {
      console.warn(`[${client.alias}] PetBagRoundTrip: inventory not known yet (not in-world?)`);
      return;
    }

    const items = INVENTORY_SLOTS.filter((s) => start[s] !== -1).map((s) => ({ slot: s, id: start[s] }));
    if (items.length === 0) {
      console.log(`[${client.alias}] PetBagRoundTrip: no items in main inventory (slots 4-11) to move`);
      return;
    }
    const freeBackpack = BACKPACK_SLOTS.filter((s) => start[s] === -1);
    if (freeBackpack.length < items.length) {
      console.warn(
        `[${client.alias}] PetBagRoundTrip: need ${items.length} free backpack slots, have ${freeBackpack.length} — aborting`,
      );
      return;
    }

    this.running = true;
    console.log(`[${client.alias}] PetBagRoundTrip: testing ${items.length} item(s), timeout ${timeoutMs}ms each`);
    const trips: ItemTrip[] = [];
    try {
      // Forward leg: inventory slot -> a free backpack slot.
      for (let i = 0; i < items.length; i++) {
        const { slot: fromSlot, id: itemId } = items[i];
        const toSlot = freeBackpack[i];
        const t0 = Date.now();
        client.swapInventorySlots(fromSlot, toSlot);
        const forwardOk = await this.waitFor(
          client,
          (inv) => inv[toSlot] === itemId && inv[fromSlot] === -1,
          timeoutMs,
        );
        const forwardMs = Date.now() - t0;
        if (!forwardOk) {
          this.reportFailure(client, 'forward', itemId, fromSlot, toSlot);
        }
        trips.push({ itemId, fromSlot, toSlot, forwardMs, forwardOk, backMs: -1, backOk: false });
      }

      // Return leg: backpack slot -> the original inventory slot.
      for (const trip of trips) {
        if (!trip.forwardOk) {
          continue; // never made it out; don't try to bring it back
        }
        const t0 = Date.now();
        client.swapInventorySlots(trip.toSlot, trip.fromSlot);
        trip.backOk = await this.waitFor(
          client,
          (inv) => inv[trip.fromSlot] === trip.itemId && inv[trip.toSlot] === -1,
          timeoutMs,
        );
        trip.backMs = Date.now() - t0;
        if (!trip.backOk) {
          this.reportFailure(client, 'return', trip.itemId, trip.toSlot, trip.fromSlot);
        }
      }

      this.report(client, start, trips);
    } finally {
      this.running = false;
    }
  }

  /** Resolves true once `predicate(inventory)` holds, or false on timeout. */
  private waitFor(client: Client, predicate: (inv: number[]) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        const inv = client.getInventory();
        if (inv && predicate(inv)) {
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          resolve(false);
        } else {
          setTimeout(check, POLL_MS);
        }
      };
      check();
    });
  }

  private reportFailure(client: Client, leg: string, itemId: number, from: number, to: number): void {
    const inv = client.getInventory();
    const seen = inv ? inv.indexOf(itemId) : -1;
    console.warn(
      `[${client.alias}] PetBagRoundTrip: ⚠ ${leg} move of item ${itemId} (slot ${from}→${to}) NOT confirmed — ` +
        (seen === -1
          ? `item ${itemId} is no longer in any slot (server VOID)`
          : `item is now in slot ${seen} (server placed it elsewhere)`),
    );
  }

  private report(client: Client, start: number[], trips: ItemTrip[]): void {
    const end = client.getInventory() ?? [];
    const restored = start.every((id, slot) => id === (end[slot] ?? -1));
    const voids = trips.filter((t) => !t.forwardOk || !t.backOk).length;
    console.log(`[${client.alias}] PetBagRoundTrip results:`);
    for (const t of trips) {
      console.log(
        `  item ${t.itemId}: out ${t.forwardOk ? `${t.forwardMs}ms` : 'FAILED'}, ` +
          `back ${t.backOk ? `${t.backMs}ms` : t.forwardOk ? 'FAILED' : 'skipped'}`,
      );
    }
    const ok = trips.filter((t) => t.forwardOk && t.backOk);
    if (ok.length) {
      const rtts = ok.map((t) => t.forwardMs + t.backMs);
      const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
      console.log(`  ${ok.length}/${trips.length} clean round-trips, avg ${avg}ms; ${voids} problem(s)`);
    } else {
      console.log(`  0/${trips.length} clean round-trips; ${voids} problem(s)`);
    }
    console.log(
      restored
        ? `  ✓ inventory fully restored to its starting layout`
        : `  ⚠ inventory did NOT return to its starting layout — check the warnings above`,
    );
  }
}
