import { Classes, PortalType, QuestObjectIdPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { RealmPortal, TrackedObject } from '../models';
import { EventHook, PacketHook, Plugin } from './decorators';

type AutoQuestState =
  | 'idle'
  | 'walkingPortalArea'
  | 'seekingPortal'
  | 'walkingPortal'
  | 'awaitingRealm'
  | 'questing'
  | 'stopped';

const PORTAL_AREA = { x: 130, y: 110 };
const DEFAULT_SHOOT_RANGE = 6;
const DEFAULT_SHOOT_INTERVAL_MS = 450;
const DEFAULT_QUEST_REFRESH_MS = 1200;
const DEFAULT_MAX_SHOTS = 3;

const PLAYER_TYPES = new Set<number>(Object.values(Classes).filter((value): value is number => typeof value === 'number'));
const PORTAL_TYPES = new Set<number>(Object.values(PortalType).filter((value): value is number => typeof value === 'number'));

/**
 * Enters an open realm, tracks the current quest object, walks toward it, and
 * periodically aims at nearby enemy-like objects.
 */
@Plugin({
  name: 'AutoQuest',
  description: 'Walks into a realm, follows QUESTOBJID targets, and shoots nearby enemies.',
  author: 'realmlib',
  version: '1.0.0',
})
export class AutoQuest {
  private state: AutoQuestState = 'idle';
  private targetPortal: RealmPortal | undefined;
  private questObjectId = -1;
  private lastShotAt = 0;
  private lastQuestMoveAt = 0;
  private readonly shootRange = readPositiveNumber('AUTO_QUEST_SHOOT_RANGE', DEFAULT_SHOOT_RANGE);
  private readonly shootIntervalMs = readPositiveInt('AUTO_QUEST_SHOOT_INTERVAL_MS', DEFAULT_SHOOT_INTERVAL_MS);
  private readonly questRefreshMs = readPositiveInt('AUTO_QUEST_REFRESH_MS', DEFAULT_QUEST_REFRESH_MS);
  private readonly maxShots = readPositiveInt('AUTO_QUEST_MAX_SHOTS', DEFAULT_MAX_SHOTS);

  /** Starts by walking to the realm portal area when the client reaches Nexus. */
  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'walkingPortalArea';
    console.log(`[${client.alias}] AutoQuest: walking to realm portal area`);
    client.moveTo(PORTAL_AREA);
  }

  /** Re-evaluates visible realm portals as Nexus portal stats update. */
  @EventHook(ClientEvent.RealmPortal)
  onRealmPortal(client: Client): void {
    this.stepTowardPortal(client);
  }

  /** Enters the selected realm portal once movement reaches it. */
  @EventHook(ClientEvent.ReachedTarget)
  onReachedTarget(client: Client, target: { x: number; y: number }): void {
    if (this.state === 'walkingPortalArea' && distance(target, PORTAL_AREA) <= 0.1) {
      this.state = 'seekingPortal';
      console.log(`[${client.alias}] AutoQuest: looking for an open realm portal`);
      this.stepTowardPortal(client);
      return;
    }
    if (this.state !== 'walkingPortal' || !this.targetPortal) {
      return;
    }
    this.state = 'awaitingRealm';
    console.log(`[${client.alias}] AutoQuest: entering ${this.targetPortal.name}`);
    client.usePortal(this.targetPortal.objectId);
  }

  /** Marks the realm as active after leaving Nexus. */
  @EventHook(ClientEvent.MapChange)
  onMapChange(client: Client, mapName: string): void {
    if (this.state === 'awaitingRealm' && mapName !== 'Nexus') {
      this.state = 'questing';
      console.log(`[${client.alias}] AutoQuest: questing in ${mapName}`);
    }
  }

  /** Stores the current server-selected quest object id. */
  @PacketHook()
  onQuestObjectId(client: Client, packet: QuestObjectIdPacket): void {
    this.questObjectId = packet.objectId;
    if (packet.objectId > 0) {
      console.log(`[${client.alias}] AutoQuest: quest target object ${packet.objectId}`);
    }
  }

  /** Drives portal selection, quest movement, and nearby shooting. */
  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    if (this.state === 'seekingPortal') {
      this.stepTowardPortal(client);
    } else if (this.state === 'questing') {
      this.followQuest(client);
      this.shootNearby(client);
    }
  }

  /** Current plugin state for console inspection/tests. */
  status(): { state: AutoQuestState; questObjectId: number; targetPortal?: string } {
    return { state: this.state, questObjectId: this.questObjectId, targetPortal: this.targetPortal?.name };
  }

  private stepTowardPortal(client: Client): void {
    if (this.state !== 'seekingPortal') {
      return;
    }
    const portal = AutoQuest.pickPortal(client.realmPortals());
    if (!portal) {
      return;
    }
    this.targetPortal = portal;
    this.state = 'walkingPortal';
    console.log(`[${client.alias}] AutoQuest: walking to ${portal.name} (${portal.players}/${portal.maxPlayers})`);
    client.moveTo({ x: portal.x, y: portal.y });
  }

  private followQuest(client: Client): void {
    if (this.questObjectId <= 0 || Date.now() - this.lastQuestMoveAt < this.questRefreshMs) {
      return;
    }
    const quest = client.visibleObjects().find((object) => object.objectId === this.questObjectId);
    if (!quest) {
      return;
    }
    this.lastQuestMoveAt = Date.now();
    client.moveTo({ x: quest.x, y: quest.y });
  }

  private shootNearby(client: Client): void {
    if (Date.now() - this.lastShotAt < this.shootIntervalMs) {
      return;
    }
    const pos = client.getPosition();
    const targets = client.visibleObjects()
      .filter((object) => this.isShootable(object))
      .map((object) => ({ object, distance: distance(pos, object) }))
      .filter((entry) => entry.distance <= this.shootRange)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.maxShots);

    if (targets.length === 0) {
      return;
    }
    this.lastShotAt = Date.now();
    for (const { object } of targets) {
      client.shootAt({ x: object.x, y: object.y });
    }
  }

  private isShootable(object: TrackedObject): boolean {
    if (object.objectId === this.questObjectId) {
      return true;
    }
    if (PORTAL_TYPES.has(object.type) || PLAYER_TYPES.has(object.type)) {
      return false;
    }
    return !/portal|nexus|vault|bazaar|quest room/i.test(object.name ?? '');
  }

  /** Selects the least-populated open realm portal. */
  static pickPortal(portals: RealmPortal[]): RealmPortal | undefined {
    return portals
      .filter((portal) => portal.players < portal.maxPlayers)
      .sort((a, b) => a.players - b.players || a.openedAt - b.openedAt)[0];
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
