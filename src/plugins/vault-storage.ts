import { VaultContentPacket } from 'realmlib';
import { Client, SlotRef } from '../client';
import { ClientEvent } from '../events';
import { EventHook, Plugin } from './decorators';

const INVENTORY_SLOTS = [4, 5, 6, 7, 8, 9, 10, 11];
const MOVE_SPACING_MS = 300;
const SETTLE_TIMEOUT_MS = 6000;
const POLL_MS = 100;
const WAIT_MS = 60000;

type State = 'idle' | 'goingToVault' | 'moving' | 'escaping' | 'waiting';
type Phase = 'deposit' | 'withdraw';

interface PlannedMove {
  from: SlotRef;
  to: SlotRef;
  /** The player inventory slot this move touches, used to confirm it settled. */
  playerSlot: number;
  /** True if that slot should end up holding an item (withdraw), false if it should empty (deposit). */
  expectFilled: boolean;
}

/**
 * Cycles a character's inventory through the vault on a loop:
 *
 *   1. On reaching the nexus, walks to the vault and enters it.
 *   2. Deposits every main-inventory item (slots 4-11) into the main vault chest
 *      via INVSWAP, into the first free chest slots.
 *   3. Waits for the swaps to settle, then sends ESCAPE back to the nexus.
 *   4. Checks (and logs) whether the inventory is now empty.
 *   5. Waits 60 seconds.
 *   6. Runs the same cycle in reverse — re-enters the vault, withdraws the items
 *      back into the inventory, escapes — then loops back to step 1.
 *
 * The loop is driven by the EnterNexus event: ESCAPE makes the server reconnect
 * us to the nexus, which re-fires EnterNexus, so each cycle naturally hands off
 * to the next. Auto-starts on the first nexus entry.
 *
 * Only the 8 main-inventory slots are cycled; equipped items (0-3) and the
 * backpack (12-19) are left alone.
 */
@Plugin({
  name: 'VaultStorage',
  description: 'Loops depositing the inventory into the vault and withdrawing it back, 60s between cycles.',
  author: 'realmlib',
  version: '1.0.0',
})
export class VaultStorage {
  private state: State = 'idle';
  private phase: Phase = 'deposit';
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Drives the loop: first start, and each return to the nexus after an ESCAPE. */
  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    if (this.state === 'idle') {
      this.phase = 'deposit';
      this.beginVaultVisit(client);
    } else if (this.state === 'escaping') {
      this.onReturnedToNexus(client);
    }
  }

  /** Once the full vault contents arrive, run the moves for the current phase. */
  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, vault: VaultContentPacket): void {
    if (this.state !== 'goingToVault' || !vault.lastVaultPacket) {
      return; // not our turn, or contents still arriving in chunks
    }
    this.state = 'moving';
    void this.performAndEscape(client, vault);
  }

  /** Current loop state, for console inspection. */
  status(): { state: State; phase: Phase } {
    return { state: this.state, phase: this.phase };
  }

  /** Walks to and enters the vault for the current phase. */
  private beginVaultVisit(client: Client): void {
    this.state = 'goingToVault';
    console.log(`[${client.alias}] VaultStorage: ${this.phase} — entering vault`);
    client.enterVault();
  }

  /** Performs all INVSWAPs for the current phase, waits for them, then escapes. */
  private async performAndEscape(client: Client, vault: VaultContentPacket): Promise<void> {
    const moves = this.plan(client, vault);
    if (moves.length === 0) {
      console.log(`[${client.alias}] VaultStorage: nothing to ${this.phase}`);
    } else {
      console.log(`[${client.alias}] VaultStorage: ${this.phase} — moving ${moves.length} item(s) via INVSWAP`);
      for (const move of moves) {
        client.invSwap(move.from, move.to);
        await sleep(MOVE_SPACING_MS);
      }
      const settled = await this.waitFor(
        client,
        (inv) => moves.every((m) => (m.expectFilled ? (inv[m.playerSlot] ?? -1) !== -1 : (inv[m.playerSlot] ?? -1) === -1)),
        SETTLE_TIMEOUT_MS,
      );
      console.log(
        settled
          ? `[${client.alias}] VaultStorage: ${this.phase} swaps confirmed`
          : `[${client.alias}] VaultStorage: ⚠ ${this.phase} swaps not fully confirmed before timeout`,
      );
    }
    console.log(`[${client.alias}] VaultStorage: sending ESCAPE`);
    this.state = 'escaping';
    client.escape();
  }

  /** Plans the INVSWAPs for the current phase from the live inventory + vault snapshot. */
  private plan(client: Client, vault: VaultContentPacket): PlannedMove[] {
    const inv = client.getInventory() ?? [];
    const playerId = client.getObjectId();
    const chestId = vault.chestObjectId;
    const moves: PlannedMove[] = [];

    if (this.phase === 'deposit') {
      const freeVaultSlots = vault.vaultContents
        .map((id, index) => ({ id, index }))
        .filter((slot) => slot.id === -1)
        .map((slot) => slot.index);
      let next = 0;
      for (const slot of INVENTORY_SLOTS) {
        const item = inv[slot] ?? -1;
        if (item === -1) {
          continue;
        }
        if (next >= freeVaultSlots.length) {
          console.warn(`[${client.alias}] VaultStorage: ⚠ vault is full — depositing only ${moves.length} item(s)`);
          break;
        }
        const vaultSlot = freeVaultSlots[next++];
        moves.push({
          from: { objectId: playerId, slotId: slot, itemType: item },
          to: { objectId: chestId, slotId: vaultSlot, itemType: -1 },
          playerSlot: slot,
          expectFilled: false,
        });
      }
    } else {
      const freeInvSlots = INVENTORY_SLOTS.filter((slot) => (inv[slot] ?? -1) === -1);
      let next = 0;
      for (let vaultSlot = 0; vaultSlot < vault.vaultContents.length; vaultSlot++) {
        const item = vault.vaultContents[vaultSlot];
        if (item === -1) {
          continue;
        }
        if (next >= freeInvSlots.length) {
          console.warn(`[${client.alias}] VaultStorage: ⚠ inventory is full — withdrawing only ${moves.length} item(s)`);
          break;
        }
        const invSlot = freeInvSlots[next++];
        moves.push({
          from: { objectId: chestId, slotId: vaultSlot, itemType: item },
          to: { objectId: playerId, slotId: invSlot, itemType: -1 },
          playerSlot: invSlot,
          expectFilled: true,
        });
      }
    }
    return moves;
  }

  /** Step 4/6: report the resulting inventory, then wait 60s and start the next (flipped) cycle. */
  private onReturnedToNexus(client: Client): void {
    const inv = client.getInventory() ?? [];
    const items = INVENTORY_SLOTS.filter((slot) => (inv[slot] ?? -1) !== -1);
    if (this.phase === 'deposit') {
      console.log(
        items.length === 0
          ? `[${client.alias}] VaultStorage: ✓ inventory is empty after depositing`
          : `[${client.alias}] VaultStorage: ⚠ inventory still has ${items.length} item(s) after deposit: ` +
              `[${items.map((s) => inv[s]).join(', ')}]`,
      );
    } else {
      console.log(`[${client.alias}] VaultStorage: withdrew items — inventory now holds ${items.length} item(s)`);
    }

    console.log(`[${client.alias}] VaultStorage: waiting ${WAIT_MS / 1000}s before the next cycle`);
    this.state = 'waiting';
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.phase = this.phase === 'deposit' ? 'withdraw' : 'deposit';
      this.beginVaultVisit(client);
    }, WAIT_MS);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Resolves true once `predicate(inventory)` holds, or false on timeout. */
  private waitFor(client: Client, predicate: (inv: number[]) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        const inv = client.getInventory() ?? [];
        if (predicate(inv)) {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
