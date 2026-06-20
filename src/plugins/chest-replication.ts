import { InvResultPacket, PortalType } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { TrackedObject } from '../models';
import { EventHook, PacketHook, Plugin } from './decorators';

type State =
  | 'idle'
  | 'findingFirstBazaar'
  | 'walkingFirstBazaar'
  | 'awaitingFirstBazaar'
  | 'checkingFirstBazaar'
  | 'switchingServer'
  | 'checkingSecondNexus'
  | 'findingSecondBazaar'
  | 'walkingSecondBazaar'
  | 'awaitingSecondBazaar'
  | 'checkingFinal'
  | 'complete'
  | 'stopped';

interface InventorySnapshot {
  inventory: number[];
  backpack: number[];
}

interface SlotMove {
  from: number;
  to: number;
}

const INVENTORY_SLOTS = range(4, 11);
const BACKPACK_SLOTS = range(12, 19);
const DEFAULT_CHECK_DELAY_MS = 5000;
const DEFAULT_MOVE_SETTLE_MS = 2500;
const DEFAULT_PORTAL_TIMEOUT_MS = 30000;

/**
 * Test-server-only sync diagnostic for checking whether inventory/backpack
 * state persists correctly across Bazaar transitions and server changes.
 */
@Plugin({
  name: 'ChestReplication',
  description: 'Inventory/pet backpack persistence check across Bazaar and server transitions.',
  author: 'realmlib',
  version: '1.0.0',
})
export class ChestReplication {
  private state: State = 'idle';
  private currentMap = '';
  private targetPortal: TrackedObject | undefined;
  private baselineItems: number[] = [];
  private readonly preferredPortal = (process.env.CHEST_REPLICATION_BAZAAR ?? 'any').toLowerCase();
  private readonly checkDelayMs = readPositiveInt('CHEST_REPLICATION_CHECK_DELAY_MS', DEFAULT_CHECK_DELAY_MS);
  private readonly moveSettleMs = readPositiveInt('CHEST_REPLICATION_MOVE_SETTLE_MS', DEFAULT_MOVE_SETTLE_MS);
  private readonly portalTimeoutMs = readPositiveInt('CHEST_REPLICATION_PORTAL_TIMEOUT_MS', DEFAULT_PORTAL_TIMEOUT_MS);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private portalStartedAt = 0;

  /** Starts the diagnostic after the client loads into a Nexus on an allowlisted host. */
  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    this.currentMap = 'Nexus';
    if (this.state === 'idle') {
      this.state = 'findingFirstBazaar';
      console.log(`[${client.alias}] ChestReplication: starting on ${client.getServerHost()}`);
      this.step(client);
      return;
    }
    if (this.state === 'switchingServer') {
      this.state = 'checkingSecondNexus';
      this.scheduleInventoryCheck(client, 'secondNexus');
    }
  }

  /** Tracks map changes so Bazaar arrival can advance the state machine. */
  @EventHook(ClientEvent.MapChange)
  onMapChange(client: Client, mapName: string): void {
    this.currentMap = mapName;
    if (mapName === 'Nexus') {
      return;
    }
    if (this.state === 'awaitingFirstBazaar') {
      this.state = 'checkingFirstBazaar';
      console.log(`[${client.alias}] ChestReplication: entered ${mapName}; checking containers`);
      this.scheduleInventoryCheck(client, 'firstBazaar');
    } else if (this.state === 'awaitingSecondBazaar') {
      this.state = 'checkingFinal';
      console.log(`[${client.alias}] ChestReplication: entered ${mapName}; verifying final container state`);
      this.scheduleInventoryCheck(client, 'finalBazaar');
    }
  }

  /** Uses the selected Bazaar portal once walking reaches it. */
  @EventHook(ClientEvent.ReachedTarget)
  onReachedTarget(client: Client): void {
    if ((this.state !== 'walkingFirstBazaar' && this.state !== 'walkingSecondBazaar') || !this.targetPortal) {
      return;
    }
    const nextState = this.state === 'walkingFirstBazaar' ? 'awaitingFirstBazaar' : 'awaitingSecondBazaar';
    this.state = nextState;
    console.log(`[${client.alias}] ChestReplication: using ${this.targetPortal.name ?? 'Bazaar'} portal`);
    client.usePortal(this.targetPortal.objectId);
  }

  /** Keeps scanning visible Nexus objects until the preferred Bazaar portal appears. */
  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    this.step(client);
  }

  /** Logs inventory swap results while this diagnostic is active. */
  @PacketHook()
  onInvResult(client: Client, packet: InvResultPacket): void {
    if (this.state === 'idle' || this.state === 'complete' || this.state === 'stopped') {
      return;
    }
    const ok = packet.unknownBool ? 'ok' : 'failed';
    console.log(
      `[${client.alias}] ChestReplication: INVRESULT ${ok} ` +
        `${packet.fromSlot.slotId}->${packet.toSlot.slotId} (${packet.fromSlot.objectType}->${packet.toSlot.objectType})`,
    );
  }

  /** Current diagnostic state and latest tracked baseline items. */
  status(): { state: State; map: string; baselineItems: number[] } {
    return { state: this.state, map: this.currentMap, baselineItems: [...this.baselineItems] };
  }

  private step(client: Client): void {
    if (this.state !== 'findingFirstBazaar' && this.state !== 'findingSecondBazaar') {
      return;
    }
    if (Date.now() - this.portalStartedAt > this.portalTimeoutMs && this.portalStartedAt !== 0) {
      this.stop(client, `Bazaar portal was not found within ${this.portalTimeoutMs}ms`);
      return;
    }
    const portal = this.findBazaarPortal(client);
    if (!portal) {
      if (this.portalStartedAt === 0) {
        this.portalStartedAt = Date.now();
        console.log(`[${client.alias}] ChestReplication: waiting for ${this.preferredPortalLabel()} Bazaar portal`);
      }
      return;
    }
    this.portalStartedAt = 0;
    this.targetPortal = portal;
    this.state = this.state === 'findingFirstBazaar' ? 'walkingFirstBazaar' : 'walkingSecondBazaar';
    console.log(
      `[${client.alias}] ChestReplication: walking to ${portal.name ?? 'Bazaar'} portal ` +
        `at (${portal.x.toFixed(1)}, ${portal.y.toFixed(1)})`,
    );
    client.moveTo({ x: portal.x, y: portal.y });
  }

  private scheduleInventoryCheck(client: Client, stage: 'firstBazaar' | 'secondNexus' | 'finalBazaar'): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (stage === 'finalBazaar') {
        this.verifyFinal(client);
      } else {
        this.normalizeInventory(client, stage);
      }
    }, this.checkDelayMs);
  }

  private normalizeInventory(client: Client, stage: 'firstBazaar' | 'secondNexus'): void {
    const snapshot = this.snapshot(client);
    this.logSnapshot(client, stage, snapshot);
    const inventoryItems = items(snapshot.inventory);
    const backpackItems = items(snapshot.backpack);

    if (inventoryItems.length > 0) {
      this.captureBaseline(inventoryItems);
      this.afterNormalize(client, stage);
      return;
    }
    if (backpackItems.length === 0) {
      this.stop(client, `${stage}: inventory and backpack are both empty`);
      return;
    }
    const moves = this.planBackpackMoves(snapshot);
    if (moves.length !== backpackItems.length) {
      this.stop(client, `${stage}: not enough empty inventory slots to move backpack items`);
      return;
    }
    this.captureBaseline(backpackItems);
    this.sendMoves(client, moves);
    setTimeout(() => this.afterNormalize(client, stage), this.moveSettleMs);
  }

  private afterNormalize(client: Client, stage: 'firstBazaar' | 'secondNexus'): void {
    if (this.state === 'stopped') {
      return;
    }
    if (stage === 'firstBazaar') {
      const next = this.pickNextServer(client);
      if (!next) {
        this.stop(client, 'no different allowlisted test server is available');
        return;
      }
      this.state = 'switchingServer';
      console.log(`[${client.alias}] ChestReplication: switching to ${next.name} (${next.address})`);
      client.connectToServer(next.address);
    } else {
      this.state = 'findingSecondBazaar';
      this.step(client);
    }
  }

  private verifyFinal(client: Client): void {
    const snapshot = this.snapshot(client);
    this.logSnapshot(client, 'finalBazaar', snapshot);
    const inventoryItems = items(snapshot.inventory);
    const backpackItems = items(snapshot.backpack);
    const replicated = this.baselineItems.some(
      (item) => inventoryItems.includes(item) && backpackItems.includes(item),
    );
    if (!replicated) {
      this.stop(client, 'final check did not find tracked items in both inventory and backpack');
      return;
    }
    this.state = 'complete';
    console.log(`[${client.alias}] ChestReplication: success - tracked items are present in both containers`);
  }

  private snapshot(client: Client): InventorySnapshot {
    const inventory = client.getPlayer()?.inventory ?? [];
    return {
      inventory: INVENTORY_SLOTS.map((slot) => inventory[slot] ?? -1),
      backpack: BACKPACK_SLOTS.map((slot) => inventory[slot] ?? -1),
    };
  }

  private planBackpackMoves(snapshot: InventorySnapshot): SlotMove[] {
    const emptyInventorySlots = snapshot.inventory
      .map((item, index) => ({ item, slot: INVENTORY_SLOTS[index] }))
      .filter((slot) => slot.item === -1)
      .map((slot) => slot.slot);
    const occupiedBackpackSlots = snapshot.backpack
      .map((item, index) => ({ item, slot: BACKPACK_SLOTS[index] }))
      .filter((slot) => slot.item !== -1)
      .map((slot) => slot.slot);

    return occupiedBackpackSlots.slice(0, emptyInventorySlots.length).map((from, index) => ({
      from,
      to: emptyInventorySlots[index],
    }));
  }

  private sendMoves(client: Client, moves: SlotMove[]): void {
    for (const [index, move] of moves.entries()) {
      setTimeout(() => {
        console.log(`[${client.alias}] ChestReplication: moving backpack slot ${move.from} -> inventory slot ${move.to}`);
        client.swapInventorySlots(move.from, move.to);
      }, index * 250);
    }
  }

  private findBazaarPortal(client: Client): TrackedObject | undefined {
    const portals = client.visibleObjects().filter((object) => this.isBazaarPortal(object));
    if (portals.length === 0) {
      return undefined;
    }
    const preferred = portals.find((portal) => this.matchesPreferredPortal(portal));
    return preferred ?? portals.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))[0];
  }

  private isBazaarPortal(object: TrackedObject): boolean {
    return object.type === PortalType.GrandBazaar || /bazaar/i.test(object.name ?? '');
  }

  private matchesPreferredPortal(object: TrackedObject): boolean {
    if (this.preferredPortal === 'any') {
      return true;
    }
    const name = (object.name ?? '').toLowerCase().replace(/\s+/g, '');
    return name.includes(this.preferredPortal.replace(/\s+/g, ''));
  }

  private pickNextServer(client: Client): { name: string; address: string } | undefined {
    const explicit = process.env.CHEST_REPLICATION_NEXT_SERVER;
    const servers = client.knownServers();
    if (explicit) {
      return servers.find(
        (server) => server.address === explicit || server.name.toLowerCase() === explicit.toLowerCase(),
      );
    }
    return servers.find((server) => server.address !== client.getServerHost());
  }

  private captureBaseline(sourceItems: number[]): void {
    if (this.baselineItems.length === 0) {
      this.baselineItems = unique(sourceItems);
    }
  }

  private logSnapshot(client: Client, stage: string, snapshot: InventorySnapshot): void {
    console.log(
      `[${client.alias}] ChestReplication: ${stage} inventory=[${snapshot.inventory.join(',')}] ` +
        `backpack=[${snapshot.backpack.join(',')}]`,
    );
  }

  private preferredPortalLabel(): string {
    return this.preferredPortal === 'any' ? 'any' : this.preferredPortal;
  }

  private stop(client: Client, reason: string): void {
    this.state = 'stopped';
    this.clearTimer();
    console.warn(`[${client.alias}] ChestReplication: stopped - ${reason}`);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function items(slots: number[]): number[] {
  return slots.filter((item) => item !== -1);
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function range(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value++) {
    values.push(value);
  }
  return values;
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
