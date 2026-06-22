import { VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { EventHook, Plugin } from './decorators';

const INVENTORY_SLOTS = [4, 5, 6, 7, 8, 9, 10, 11];
const PET_SLOT = 0;
const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 100;

type State = 'idle' 
| 'movingToPet'     // moving item from inventory into pet bag
| 'stalling'        // start ignoring packets and stall the socket
| 'converting'      // convert the current character to non-seasonal
| 'movingToPlayer'  // moving item from pet bag back into inventory
| 'unstalling'      // end ignoring packets and resume the socket
| 'enteringVault'   // enter vault immediately
| 'depositing'      // deposit item from inventory to vault chest
| 'deleteChar'      // delete the current character - send /char/delete
| 'loadOtherChar'   // load a different character into the Nexus
| 'enteringVault'   // enter vault immediately
| 'checkItem'       // check that the item is in the vault chest
| 'done'            // finished successfully
| 'failed';         // something went wrong, see console for details

/**
 * Walks an item from the player's inventory into the pet's bag and then on into
 * the vault, exercising INVSWAP across three different container objects:
 *
 *   1. On reaching the nexus, reads the inventory and the active pet's object id.
 *   2. INVSWAPs the first inventory item (player object) into the pet bag
 *      (pet object, slot 0) and waits for the source slot to clear.
 *   3. Walks into the vault (the server reconnects us to the vault map).
 *   4. On the VaultContent packet, INVSWAPs that same item out of the pet bag and
 *      into the first free slot of the main vault chest, then verifies it landed.
 *
 * The pet's object id is map-scoped — entering the vault reconnects us and the
 * server assigns a fresh pet object — so step 4 reads `getPetObjectId()` again
 * on the vault side rather than reusing the nexus value.
 *
 * Auto-runs once on the first nexus entry; re-trigger from the console with
 * `pettovault <alias>`.
 */
@Plugin({
  name: 'PetToVault',
  description: 'Moves an inventory item into the pet bag, then into the vault, via INVSWAP.',
  author: 'realmlib',
  version: '1.0.0',
})
export class PetToVault {
  private state: State = 'idle';
  private running = false;
  /** The item being shuttled and the inventory slot it started in. */
  private itemId = -1;
  private fromSlot = -1;
  /** Set once the vault deposit swap has actually been sent, so stray vault updates don't trigger an early verify. */
  private depositSwapSent = false;

  /** Auto-starts the run the first time we reach the nexus. */
  @EventHook(ClientEvent.EnterNexus)
  onNexus(client: Client): void {
    if (this.state === 'idle') {
      void this.run(client);
    }
  }

  /** Handles both the deposit (on vault entry) and its verification. */
  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, vault: VaultContentPacket): void {
    if (this.state === 'enteringVault' && vault.lastVaultPacket) {
      // Wait for the final chunk so we see the complete chest contents.
      void this.deposit(client, vault);
    } else if (this.state === 'depositing' && this.depositSwapSent) {
      this.verifyDeposit(client, vault);
    }
  }

  /**
   * Runs steps 1-3: grab the pet, move the item into the pet bag, head to the
   * vault. Safe to call from the console. The vault deposit (step 4) is driven
   * by {@link onVault} once the vault map loads.
   */
  async run(client: Client, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.running) {
      console.log(`[${client.alias}] PetToVault: already running`);
      return;
    }
    this.running = true;
    this.depositSwapSent = false;
    try {
      // Step 1: wait until we're in-world with an inventory and a known pet.
      const ready = await this.waitFor(
        client,
        () => !!client.getInventory() && client.getPetObjectId() !== -1,
        timeoutMs,
      );
      if (!ready) {
        this.fail(client, 'inventory or pet object id not known (not fully in-world?)');
        return;
      }
      const inventory = client.getInventory()!;
      const playerId = client.getObjectId();
      const petId = client.getPetObjectId();

      // Step 1 (cont.): pick the first inventory item to move.
      const slot = INVENTORY_SLOTS.find((s) => inventory[s] !== -1);
      if (slot === undefined) {
        this.fail(client, 'no items in main inventory (slots 4-11) to move');
        return;
      }
      this.fromSlot = slot;
      this.itemId = inventory[slot];
      console.log(
        `[${client.alias}] PetToVault: moving item ${this.itemId} from inventory slot ${slot} ` +
          `→ pet ${petId} slot ${PET_SLOT}`,
      );

      // Step 2: INVSWAP inventory slot -> pet bag slot 0 (empty destination).
      this.state = 'movingToPet';
      client.invSwap(
        { objectId: playerId, slotId: slot, itemType: this.itemId },
        { objectId: petId, slotId: PET_SLOT, itemType: -1 },
      );
      const movedOut = await this.waitFor(client, (inv) => inv[slot] === -1, timeoutMs);
      if (!movedOut) {
        this.fail(client, `item ${this.itemId} never left inventory slot ${slot} — server rejected the pet swap`);
        return;
      }
      console.log(`[${client.alias}] PetToVault: item ${this.itemId} is now in the pet bag — entering vault`);

      // Step 3: walk to and enter the vault; onVault() takes it from here.
      this.state = 'enteringVault';
      client.enterVault();
    } finally {
      this.running = false;
    }
  }

  /** Step 4: move the item out of the pet bag into the first free vault slot. */
  private async deposit(client: Client, vault: VaultContentPacket): Promise<void> {
    this.state = 'depositing';
    // The pet got a new object id on the vault reconnect — read it fresh.
    const petReady = await this.waitFor(client, () => client.getPetObjectId() !== -1, DEFAULT_TIMEOUT_MS);
    if (!petReady) {
      this.fail(client, 'pet object id not known on the vault side');
      return;
    }
    const petId = client.getPetObjectId();
    const freeSlot = vault.vaultContents.findIndex((id) => id === -1);
    if (freeSlot === -1) {
      this.fail(client, 'main vault chest is full — no free slot to deposit into');
      return;
    }
    console.log(
      `[${client.alias}] PetToVault: depositing item ${this.itemId} from pet ${petId} slot ${PET_SLOT} ` +
        `→ vault chest ${vault.chestObjectId} slot ${freeSlot}`,
    );
    client.invSwap(
      { objectId: petId, slotId: PET_SLOT, itemType: this.itemId },
      { objectId: vault.chestObjectId, slotId: freeSlot, itemType: -1 },
    );
    this.depositSwapSent = true;
    // The server replies with a fresh VaultContent; verifyDeposit() confirms it.
  }

  /** Confirms the deposited item now shows up in the vault chest. */
  private verifyDeposit(client: Client, vault: VaultContentPacket): void {
    if (vault.vaultContents.includes(this.itemId)) {
      this.state = 'done';
      console.log(`[${client.alias}] PetToVault: ✓ item ${this.itemId} is now in the vault`);
    } else {
      this.fail(client, `item ${this.itemId} did not appear in the vault after the deposit swap`);
    }
  }

  /** Current state machine status, for console inspection. */
  status(): { state: State; itemId: number; fromSlot: number } {
    return { state: this.state, itemId: this.itemId, fromSlot: this.fromSlot };
  }

  private fail(client: Client, reason: string): void {
    this.state = 'failed';
    console.warn(`[${client.alias}] PetToVault: failed — ${reason}`);
  }

  /** Resolves true once `predicate` holds (against the live inventory), else false on timeout. */
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
