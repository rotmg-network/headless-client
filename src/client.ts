import * as net from 'net';
import { EventEmitter } from 'events';
import {
  Packet,
  DeathPacket,
  PacketIO,
  PacketType,
  HelloPacket,
  LoadPacket,
  CreatePacket,
  MovePacket,
  MoveRecord,
  PongPacket,
  UpdateAckPacket,
  GotoAckPacket,
  ShootAckPacket,
  PlayerShootPacket,
  MapInfoPacket,
  UpdatePacket,
  NewTickPacket,
  PingPacket,
  FailurePacket,
  ReconnectPacket,
  ServerPlayerShootPacket,
  EnemyShootPacket,
  CreateSuccessPacket,
  QueueInfoPacket,
  ShowAllyShootPacket,
  UsePortalPacket,
  InvSwapPacket,
  VaultContentPacket,
  EscapePacket,
  SlotObjectData,
  ObjectData,
  ObjectStatusData,
  StatType,
  RawPacket,
  PlayerData,
  Classes,
  FailureCode,
  ProtocolError,
  processObject,
  processObjectStatus,
  parsePlayerClass,
  hexdump,
  PortalType,
  GotoPacket,
} from 'realmlib';
import { BUILD_VERSION, GAME_ID, GAME_PORT, HELLO_TOKEN } from './constants';
import { config } from './config';
import { ClientEvent } from './events';
import { RealmPortal, ClientOptions, ClientServer, TrackedObject } from './models';

/** Context passed to packet hooks so one plugin can stop later hooks. */
export interface PacketContext {
  readonly type: PacketType;
  readonly packet: Packet;
  readonly cancelled: boolean;
  cancel(reason?: string): void;
  cancelReason?: string;
}

interface MutablePacketContext extends PacketContext {
  cancelled: boolean;
  cancelReason?: string;
}

interface PacketHandlerEntry {
  handler: (packet: Packet, ctx: PacketContext) => void;
  priority: number;
  order: number;
}

/**
 * A headless client for one account. Logs in, runs the keep-alive loop, and
 * acts as the event surface plugins hook into: it re-emits incoming packets by
 * PacketType and emits higher-level game events ('ready', 'enterVault', …).
 */
export class Client extends EventEmitter {
  private socket!: net.Socket;
  private io!: PacketIO;

  /** Packet types any plugin has hooked; bridged onto each fresh io. */
  private readonly subscribedPacketTypes = new Set<PacketType>();
  private readonly packetHandlers = new Map<PacketType, PacketHandlerEntry[]>();
  private packetHandlerOrder = 0;

  // Current server / map state
  private host: string;
  private port = GAME_PORT;
  private gameId = GAME_ID.NEXUS;
  private key: number[] = [];
  private keyTime = -1;

  // Current player state
  private objectId = -1;
  private pos = { x: 0, y: 0 };
  private posKnown = false;
  /** Latest authoritative self-position the server reported via NewTick. Drives movement so we never outrun the server. */
  private serverPos: { x: number; y: number } | undefined;
  private moveBestDist = Infinity;
  private moveStallMs = 0;
  private moveStallWarned = false;
  private connectStart = 0;
  private lastFrameTime = 0;
  private tickCount = 0;
  private readonly seenUnknown = new Set<number>();
  private player: PlayerData | undefined;
  private inQueue = false;
  private nextBulletId = 0;
  private stalled = false;
  private stalledAt = 0;
  /** Outgoing packets captured while stalled, flushed in order on resume (mimics a TCP send buffer). */
  private readonly stallQueue: Packet[] = [];
  private stallRawSend: ((packet: Packet) => void) | undefined;
  private stallRecvUpdates = 0;
  private stallRecvTicks = 0;
  private static readonly STALL_QUEUE_CAP = 20000;

  // Navigation / vault state
  private wantVault = false;
  private readonly objects = new Map<number, TrackedObject>();
  private readonly portals = new Map<number, RealmPortal>();
  private vaultPortalId: number | undefined;
  private target: { x: number; y: number; threshold: number } | undefined;
  private enteringVault = false;
  private inVault = false;
  private dumped = false;
  private lastUsePortalTick = -100;
  private usePortalAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Movement speed multipliers
  private static readonly SPEED_MIN = 0.004;
  private static readonly SPEED_MAX = 0.0096;

  /** Creates a client bound to one authenticated account and starting server. */
  constructor(private readonly opts: ClientOptions) {
    super();
    this.setMaxListeners(0); // plugins may add many listeners
    this.host = opts.host;
    this.wantVault = opts.autoEnterVault ?? config.autoEnterVault;
  }

  //#region plugin-facing surface

  /**
   * Hooks an incoming packet type. Higher priority handlers run first and can
   * cancel later packet hooks through PacketContext.
   */
  onPacket<T extends Packet>(
    type: PacketType,
    handler: (packet: T, ctx: PacketContext) => void,
    options: { priority?: number } = {},
  ): this {
    if (!this.subscribedPacketTypes.has(type)) {
      this.subscribedPacketTypes.add(type);
      // Bridge io -> this for the type if already connected; otherwise
      // registerHandlers() will bridge it on (re)connect.
      this.bridgePacket(type);
    }
    const handlers = this.packetHandlers.get(type) ?? [];
    handlers.push({
      handler: handler as (packet: Packet, ctx: PacketContext) => void,
      priority: options.priority ?? 0,
      order: this.packetHandlerOrder++,
    });
    handlers.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.packetHandlers.set(type, handlers);
    return this;
  }

  /** Removes a packet hook registered with onPacket. */
  offPacket<T extends Packet>(type: PacketType, handler: (packet: T, ctx: PacketContext) => void): this {
    const handlers = this.packetHandlers.get(type);
    if (!handlers) {
      return this;
    }
    this.packetHandlers.set(
      type,
      handlers.filter((entry) => entry.handler !== handler),
    );
    return this;
  }

  /** Sends a packet to the server. */
  send(packet: Packet): void {
    this.io?.send(packet);
  }

  /** Walks the player toward a position (cleared on arrival, emits 'reachedTarget'). */
  moveTo(target: { x: number; y: number }, arriveThreshold = config.arriveThreshold): void {
    this.target = { x: target.x, y: target.y, threshold: arriveThreshold };
    this.moveBestDist = Infinity;
    this.moveStallMs = 0;
    this.moveStallWarned = false;
  }

  /** Short account label used in logs and console commands. */
  get alias(): string {
    return this.opts.alias;
  }

  /** Latest parsed player stats, if the player has appeared in an update. */
  getPlayer(): PlayerData | undefined {
    return this.player;
  }

  /** Current estimated (dead-reckoned) player position. */
  getPosition(): { x: number; y: number } {
    return { x: this.pos.x, y: this.pos.y };
  }

  /** Latest position the server reported for us (authoritative), if any. */
  getServerPosition(): { x: number; y: number } | undefined {
    return this.serverPos ? { ...this.serverPos } : undefined;
  }

  /** Current in-world object id, or -1 before CreateSuccess. */
  getObjectId(): number {
    return this.objectId;
  }

  /** Whether the last MapInfo identified the current map as a vault. */
  isInVault(): boolean {
    return this.inVault;
  }

  /** The realm portals currently tracked in the nexus. */
  realmPortals(): RealmPortal[] {
    return [...this.portals.values()];
  }

  /** Visible non-player objects currently tracked from UPDATE/NEWTICK state. */
  visibleObjects(): TrackedObject[] {
    return [...this.objects.values()];
  }

  /** Hostname/address of the server this client is currently connected to. */
  getServerHost(): string {
    return this.host;
  }

  /** Server list returned by /char/list when this client was created. */
  knownServers(): ClientServer[] {
    return [...(this.opts.servers ?? [])];
  }

  /** First known server whose address differs from the current host. */
  differentServer(): ClientServer | undefined {
    return this.knownServers().find((server) => server.address !== this.host);
  }

  /** Sends USE_PORTAL for a visible portal object id. */
  usePortal(objectId: number): void {
    const use = new UsePortalPacket();
    use.objectId = objectId;
    this.io.send(use);
  }

  /** Sends INVSWAP between two player inventory/backpack slots. */
  swapInventorySlots(fromSlotId: number, toSlotId: number): boolean {
    if (!this.player || this.objectId === -1) {
      return false;
    }
    const packet = new InvSwapPacket();
    packet.time = this.time();
    packet.position.x = this.pos.x;
    packet.position.y = this.pos.y;
    packet.slotObject1 = this.slotObject(fromSlotId);
    packet.slotObject2 = this.slotObject(toSlotId);
    this.io.send(packet);
    return true;
  }

  /** Current player inventory snapshot (20 slots: 0-3 equip, 4-11 inventory, 12-19 backpack), or undefined. */
  getInventory(): number[] | undefined {
    return this.player ? [...this.player.inventory] : undefined;
  }

  /** Whether the player has a backpack (slots 12-19 usable). */
  hasBackpack(): boolean {
    return this.player?.hasBackpack ?? false;
  }

  /** Aims at a world position and sends a PLAYERSHOOT packet with the equipped weapon. */
  shootAt(target: { x: number; y: number }, weaponSlot = 0): boolean {
    if (!this.player || this.objectId === -1) {
      return false;
    }
    const weaponType = this.player.inventory?.[weaponSlot] ?? -1;
    if (weaponType === -1) {
      return false;
    }
    const shot = new PlayerShootPacket();
    shot.time = this.time();
    shot.bulletId = this.nextBulletId++ % 128;
    shot.containerType = weaponType;
    shot.unknownByte = 0;
    shot.startingPos.x = this.pos.x;
    shot.startingPos.y = this.pos.y;
    shot.angle = Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
    shot.isBurst = false;
    shot.unknownShort = 0;
    shot.playerPos.x = this.pos.x;
    shot.playerPos.y = this.pos.y;
    this.io.send(shot);
    return true;
  }

  //#endregion

  /** Builds SlotObjectData for the current player and item in `slotId`. */
  private slotObject(slotId: number): SlotObjectData {
    const slot = new SlotObjectData();
    slot.objectId = this.objectId;
    slot.slotId = slotId;
    const item = this.player?.inventory?.[slotId] ?? -1;
    slot.objectType = item === -1 ? 0xffffffff : item;
    return slot;
  }

  /** Bridges an io packet emission onto this client's emitter (for the current io). */
  private bridgePacket(type: PacketType): void {
    this.io?.on(type, (packet: Packet) => this.dispatchPacket(type, packet));
  }

  /** Runs plugin packet hooks in priority order until one cancels the packet. */
  private dispatchPacket(type: PacketType, packet: Packet): void {
    const handlers = this.packetHandlers.get(type) ?? [];
    const ctx: MutablePacketContext = {
      type,
      packet,
      cancelled: false,
      cancel: () => undefined,
    };
    ctx.cancel = (reason?: string): void => {
      ctx.cancelled = true;
      ctx.cancelReason = reason;
    };
    for (const entry of handlers) {
      entry.handler(packet, ctx);
      if (ctx.cancelled) {
        return;
      }
    }
  }

  /**
   * Requests that the client walk to the vault portal and enter the vault.
   * Takes effect once in the nexus; safe to call before or after connecting.
   */
  enterVault(): void {
    if (this.inVault) {
      return;
    }
    this.wantVault = true;
    this.findVaultPortal(); // act now if the nexus objects are already known
  }

  /**
   * Stalls the connection: while stalled, outgoing packets are not sent but
   * *queued* in order — mimicking a real lagout, where the client's TCP send
   * buffer holds traffic and delivers it once the link recovers rather than
   * discarding it. We keep *reading* the socket (the byte stream and RC4 cipher
   * stay in sync, which a true pause/detach would break) and the handlers still
   * generate the per-tick UpdateAck/Move/Pong, so on {@link resumeSocket} the
   * full ack stream flushes and the server's ack accounting balances. The
   * connection is NOT closed. Returns false if already stalled or not connected.
   */
  stallSocket(): boolean {
    if (this.stalled || !this.socket || this.socket.destroyed) {
      return false;
    }
    this.stalled = true;
    this.stalledAt = this.time();
    this.stallQueue.length = 0;
    this.stallRecvUpdates = 0;
    this.stallRecvTicks = 0;
    console.log(`${this.tag} ⏸ socket stalled (simulated lag) — queueing outgoing until resumed`);
    return true;
  }

  /**
   * Resumes a stalled socket and flushes the queued outgoing packets in order,
   * so the server receives the acks it was owed during the stall. Returns the
   * stall duration in ms, or -1 if not stalled.
   */
  resumeSocket(): number {
    if (!this.stalled || !this.socket) {
      return -1;
    }
    const heldMs = this.time() - this.stalledAt;
    const queued = this.stallQueue.length;
    const acks = this.stallQueue.filter((p) => p.type === PacketType.UPDATEACK).length;
    const moves = this.stallQueue.filter((p) => p.type === PacketType.MOVE).length;
    this.stalled = false;
    if (!this.socket.destroyed && this.stallRawSend) {
      for (const packet of this.stallQueue) {
        this.stallRawSend(packet);
      }
    }
    this.stallQueue.length = 0;
    // Each UPDATE owed an UpdateAck and each NEWTICK owed a Move; if the flushed
    // counts match what arrived during the stall, the replay was complete.
    const updMatch = acks === this.stallRecvUpdates ? '✓' : `⚠ ${this.stallRecvUpdates} recvd`;
    const tickMatch = moves === this.stallRecvTicks ? '✓' : `⚠ ${this.stallRecvTicks} recvd`;
    console.log(
      `${this.tag} ▶ socket resumed after ${heldMs}ms — flushed ${queued} queued packet(s): ` +
        `${acks} UpdateAck (${updMatch}), ${moves} Move (${tickMatch}), ${queued - acks - moves} other` +
        `${this.socket.destroyed ? ' (server had already dropped us)' : ''}`,
    );
    return heldMs;
  }

  /**
   * Wraps the current io's send so that, while {@link stalled}, every outgoing
   * packet is queued instead of sent (and flushed in order on resume). Installed
   * once per connect (io is recreated on each connect).
   */
  private installStallGate(): void {
    const io = this.io;
    const rawSend = io.send.bind(io);
    this.stallRawSend = rawSend;
    io.send = (packet: Packet): void => {
      if (this.stalled) {
        if (this.stallQueue.length < Client.STALL_QUEUE_CAP) {
          this.stallQueue.push(packet);
        }
        return;
      }
      rawSend(packet);
    };
  }

  /** Whether the socket is currently stalled. */
  isStalled(): boolean {
    return this.stalled;
  }

  /**
   * Sends an ESCAPE packet to return to the nexus. The server replies with a
   * Reconnect, which is followed automatically.
   */
  escape(): void {
    if (!this.io) {
      console.log(`${this.tag} escape ignored — not connected`);
      return;
    }
    console.log(`${this.tag} escaping to the nexus`);
    this.io.send(new EscapePacket());
    this.wantVault = false; // don't immediately walk back into the vault
    this.clearNavState();
    this.gameId = GAME_ID.NEXUS;
    this.key = [];
    this.keyTime = -1;
  }

  /** Disconnects and connects to the given game server (its nexus). */
  connectToServer(host: string): void {
    console.log(`${this.tag} connecting to server ${host}`);
    this.resetForNexus();
    this.host = host;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.connect();
  }

  /**
   * Disconnects and reconnects to a specific Hello game id on the current or
   * supplied server. Useful for controlled map-id probing plugins.
   */
  connectToGameId(gameId: number, host = this.host): void {
    console.log(`${this.tag} connecting to gameId ${gameId} on ${host}`);
    this.clearMapState();
    this.clearNavState();
    this.host = host;
    this.gameId = gameId;
    this.key = [];
    this.keyTime = -1;
    this.inVault = false;
    this.enteringVault = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.connect();
  }

  /** Log prefix for this client. */
  private get tag(): string {
    return `[${this.opts.alias}]`;
  }

  /** Milliseconds since the current socket connected. */
  private time(): number {
    return Date.now() - this.connectStart;
  }

  /** Names a FailurePacket error code via realmlib's failure models. */
  private describeFailure(p: FailurePacket): string {
    // In-game failures are ProtocolError codes; pre-entry ones are FailureCode.
    const name = this.objectId !== -1 ? ProtocolError[p.errorId] : FailureCode[p.errorId];
    return name ?? `code ${p.errorId}`;
  }

  /** The display name of an object, from its NAME stat, if any. */
  private objectName(obj: ObjectData): string | undefined {
    return obj.status.stats.find((s) => s.statType === StatType.NAME_STAT)?.stringStatValue || undefined;
  }

  /**
   * Parses a realm portal NAME stat such as "NexusPortal.Horizon (37/85)" into
   * the realm name and player counts.
   */
  private parseRealmPortal(raw: string): { name: string; players: number; maxPlayers: number } | undefined {
    const match = /^(.*?)\s*\((\d+)\/(\d+)\)\s*$/.exec(raw);
    if (!match) {
      return undefined;
    }
    const label = match[1];
    const name = label.includes('.') ? label.slice(label.lastIndexOf('.') + 1) : label;
    return { name, players: Number(match[2]), maxPlayers: Number(match[3]) };
  }

  /** Records or refreshes a realm portal from its object status. */
  private trackRealmPortal(status: ObjectStatusData): void {
    let rawName: string | undefined;
    let openedAt: number | undefined;
    let connectId: number | undefined;
    let connectValueTwo: number | undefined;
    for (const stat of status.stats) {
      if (stat.statType === StatType.NAME_STAT) {
        rawName = stat.stringStatValue;
      } else if (stat.statType === StatType.OPENED_AT_TIMESTAMP) {
        openedAt = stat.statValue;
      } else if (stat.statType === StatType.CONNECT_STAT) {
        connectId = stat.statValue;
        connectValueTwo = stat.statValueTwo;
      }
    }
    if (rawName === undefined) {
      return;
    }
    const parsed = this.parseRealmPortal(rawName);
    if (!parsed) {
      return;
    }
    const previous = this.portals.get(status.objectId);
    const portal: RealmPortal = {
      objectId: status.objectId,
      x: status.pos.x,
      y: status.pos.y,
      name: parsed.name,
      players: parsed.players,
      maxPlayers: parsed.maxPlayers,
      openedAt: openedAt ?? previous?.openedAt ?? 0,
      connectId: connectId ?? previous?.connectId,
      connectValueTwo: connectValueTwo ?? previous?.connectValueTwo,
    };
    this.portals.set(status.objectId, portal);
    if (!previous) {
      console.log(
        `${this.tag} realm portal: ${parsed.name} (${parsed.players}/${parsed.maxPlayers}) ` +
          `opened ${openedAt ?? '?'} connect ${connectId ?? '?'}:${connectValueTwo ?? '?'}`,
      );
    }
    this.emit(ClientEvent.RealmPortal, portal);
  }

  /** Clears state tied to the current map; call on any map change. */
  private clearMapState(): void {
    this.objectId = -1;
    this.posKnown = false;
    this.player = undefined;
    this.lastFrameTime = 0;
    this.objects.clear();
    this.portals.clear();
  }

  /** Clears vault navigation progress (target, portal id, retry counters). */
  private clearNavState(): void {
    this.target = undefined;
    this.vaultPortalId = undefined;
    this.usePortalAttempts = 0;
    this.lastUsePortalTick = -100;
  }

  /** Resets to a fresh nexus connection (used after a rate-limit cooldown). */
  private resetForNexus(): void {
    this.clearMapState();
    this.clearNavState();
    this.gameId = GAME_ID.NEXUS;
    this.key = [];
    this.keyTime = -1;
    this.inVault = false;
    this.enteringVault = false;
  }

  /** Reconnects to the nexus after `ms`, e.g. once a rate-limit has cooled down. */
  private scheduleReconnect(ms: number): void {
    if (this.reconnectTimer) {
      return; // already pending; don't stack reconnects on repeated failures
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.resetForNexus();
      this.connect();
    }, ms);
  }

  /**
   * Advances `pos` one tick toward `target`. Critically, the step is taken from
   * the server's authoritative position (when known), not our dead-reckoned one
   * — so each MOVE we send stays within ~1 tile of where the server agrees we
   * are. Stepping from the local position lets it race tens of tiles ahead of
   * the server, which the server's anti-speedhack check rejects: it pins us in
   * place and every move (and any USE_PORTAL there) is silently dropped.
   */
  private stepToward(target: { x: number; y: number }, dt: number): void {
    const base = this.serverPos ?? this.pos;
    const spd = (this.player?.spd ?? 0) + (this.player?.spdBoost ?? 0);
    const tilesPerMs = Client.SPEED_MIN + (spd / 75) * (Client.SPEED_MAX - Client.SPEED_MIN);
    const step = tilesPerMs * dt;
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      this.pos = { x: target.x, y: target.y };
    } else {
      this.pos = { x: base.x + (dx / dist) * step, y: base.y + (dy / dist) * step };
    }
  }

  /** Once in the nexus, locate the vault portal by name and start navigating to it. */
  private findVaultPortal(): void {
    if (!this.wantVault || this.vaultPortalId !== undefined || this.inVault || this.enteringVault) {
      return;
    }
    for (const [id, o] of this.objects) {
      if (o.type == PortalType.Vault) {
        this.vaultPortalId = id;
        this.target = { x: o.x, y: o.y, threshold: config.arriveThreshold };
        console.log(
          `${this.tag} found vault portal "${o.name}" (id ${id}, type ${o.type}) at (${o.x.toFixed(1)}, ${o.y.toFixed(1)}) → navigating`,
        );
        return;
      }
    }
  }

  /** With DUMP_OBJECTS=1, log the named objects in view once (portal discovery aid). */
  private maybeDumpObjects(): void {
    if (this.dumped || !process.env.DUMP_OBJECTS || this.objects.size < 10) {
      return;
    }
    //this.dumped = true;
    console.log(`${this.tag} --- named objects in view (${this.objects.size} total) ---`);
    for (const [id, o] of this.objects) {
      if (o.name) {
        console.log(`${this.tag}   id ${id} type ${o.type} "${o.name}" @ (${o.x.toFixed(1)}, ${o.y.toFixed(1)})`);
      }
    }
  }

  /** Opens the TCP socket, builds PacketIO, and starts the Hello handshake. */
  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer); // a (re)connect cancels any pending scheduled one
      this.reconnectTimer = undefined;
    }
    this.stalled = false;
    this.stallQueue.length = 0;
    this.socket = new net.Socket();
    this.io = new PacketIO({ socket: this.socket });
    this.installStallGate();
    this.io.setMaxListeners(0);
    this.io.on('error', (err: Error) => console.error(`${this.tag} io error:`, err.message));
    this.registerHandlers();
    this.setupDebug();

    this.socket.on('connect', () => {
      this.connectStart = Date.now();
      console.log(`${this.tag} socket connected → sending Hello (gameId ${this.gameId})`);
      this.sendHello();
      this.emit(ClientEvent.Connected);
    });
    this.socket.on('close', () => {
      console.log(`${this.tag} socket closed`);
      this.emit(ClientEvent.Disconnect);
    });
    this.socket.on('error', (err) => console.error(`${this.tag} socket error:`, err.message));

    console.log(`${this.tag} connecting to ${this.host}:${this.port}`);
    this.socket.connect(this.port, this.host);
  }

  /**
   * Reports unknown packet ids once and, when DEBUG_PACKETS is set, logs raw
   * packet traffic for protocol debugging.
   */
  private setupDebug(): void {
    this.io.on('unknownPacket', ({ id, size }: { id: number; size: number }) => {
      if (this.seenUnknown.has(id)) {
        return;
      }
      this.seenUnknown.add(id);
      console.log(`${this.tag} ⚠️ unknown packet id ${id} (${size}b) — not in packet map`);
    });

    const mode = process.env.DEBUG_PACKETS;
    if (!mode) {
      return;
    }
    this.io.on('rawPacket', (raw: RawPacket) => {
      if (mode === 'unknown' && raw.type) {
        return;
      }
      const label = raw.type ?? `UNKNOWN(${raw.id})`;
      console.log(`${this.tag} « ${label} [id ${raw.id}, ${raw.payload.length}b]`);
      if (mode === 'hex' || (mode === 'unknown' && !raw.type)) {
        console.log(hexdump(raw.payload));
      }
    });
    if (mode !== 'unknown') {
      this.io.on('sentPacket', (sent: { id: number; type: string; size: number }) => {
        console.log(`${this.tag} » ${sent.type} [id ${sent.id}, ${sent.size}b]`);
      });
    }
  }

  /** Sends the Hello packet for the current host, game id, and reconnect key. */
  private sendHello(): void {
    const hello = new HelloPacket();
    hello.gameId = this.gameId;
    hello.buildVersion = BUILD_VERSION;
    hello.accessToken = this.opts.accessToken;
    hello.keyTime = this.keyTime;
    hello.key = this.key;
    hello.gameNet = 'rotmg';
    hello.playPlatform = 'rotmg';
    hello.platformToken = '';
    hello.userToken = this.opts.clientToken;
    hello.clientToken = HELLO_TOKEN;
    this.io.send(hello);
  }

  /** Registers core packet handlers on the current PacketIO instance. */
  private registerHandlers(): void {
    this.io.on(PacketType.MAPINFO, (p: MapInfoPacket)                     => this.handleMapInfo(p));
    this.io.on(PacketType.CREATE_SUCCESS, (p: CreateSuccessPacket)        => this.handleCreateSuccess(p));
    this.io.on(PacketType.UPDATE, (p: UpdatePacket)                       => this.handleUpdate(p));
    this.io.on(PacketType.NEWTICK, (p: NewTickPacket)                     => this.handleNewTick(p));
    this.io.on(PacketType.PING, (p: PingPacket)                           => this.handlePing(p));
    this.io.on(PacketType.SERVERPLAYERSHOOT, (p: ServerPlayerShootPacket) => this.handleServerPlayerShoot(p));
    this.io.on(PacketType.ENEMYSHOOT, (p: EnemyShootPacket)               => this.handleEnemyShoot(p));
    this.io.on(PacketType.GOTO, (p: GotoPacket)                           => this.handleGoto(p));
    this.io.on(PacketType.VAULT_CONTENT,  (p: VaultContentPacket)         => this.handleVaultContent(p));
    this.io.on(PacketType.QUEUE_INFORMATION, (p: QueueInfoPacket)         => this.handleQueueInformation(p));
    this.io.on(PacketType.RECONNECT, (p: ReconnectPacket)                 => this.handleReconnect(p));
    this.io.on(PacketType.FAILURE, (p: FailurePacket)                     => this.handleFailure(p));
    this.io.on(PacketType.DEATH, (p: DeathPacket)                         => this.handleDeath(p));

    // Re-attach plugin packet hooks: bridge every subscribed type onto this io.
    for (const type of this.subscribedPacketTypes) {
      this.bridgePacket(type);
    }
  }

  /** Handles map metadata, then creates or loads the configured character. */
  private handleMapInfo(p: MapInfoPacket): void {
    console.log(`${this.tag} ✓ MapInfo accepted: "${p.name}" (${p.width}x${p.height})`);
    this.enteringVault = false;
    this.inVault = /vault/i.test(p.name);
    if (this.inQueue) {
      console.log(`${this.tag} cleared queue — entering`);
      this.inQueue = false;
    }
    this.emit(ClientEvent.MapChange, p.name);
    if (this.inVault) {
      console.log(`${this.tag} entered Vault`);
      this.emit(ClientEvent.EnterVault);
    } else if (p.name === 'Nexus') {
      console.log(`${this.tag} entered Nexus`);
      this.emit(ClientEvent.EnterNexus);
    }
    if (this.opts.needsNewChar) {
      const create = new CreatePacket();
      create.classType = Classes.Wizard;
      create.skinType = 0;
      console.log(`${this.tag} creating new character`);
      this.io.send(create);
    } else {
      const load = new LoadPacket();
      load.charId = this.opts.charId;
      load.isFromArena = false;
      console.log(`${this.tag} loading character ${this.opts.charId}`);
      this.io.send(load);
    }
  }

  /** Records the assigned player object id and enables ally shot visibility. */
  private handleCreateSuccess(p: CreateSuccessPacket): void {
    this.objectId = p.objectId;
    this.lastFrameTime = this.time();
    console.log(`${this.tag} ✓✓ IN-WORLD as objectId ${p.objectId}`);
    const show = new ShowAllyShootPacket();
    show.toggle = 1;
    this.io.send(show);
    this.emit(ClientEvent.Ready, p.objectId);
  }

  /** Acknowledges object updates and refreshes tracked entities and portals. */
  private handleUpdate(p: UpdatePacket): void {
    if (this.stalled) {
      this.stallRecvUpdates++;
    }
    this.io.send(new UpdateAckPacket());
    if (!this.posKnown && p.pos) {
      this.pos = { x: p.pos.x, y: p.pos.y };
      this.posKnown = true;
    }
    for (const obj of p.newObjects) {
      if (obj.status.objectId === this.objectId) {
        this.pos = { x: obj.status.pos.x, y: obj.status.pos.y };
        this.posKnown = true;
        this.player = processObject(obj);
      } else {
        this.objects.set(obj.status.objectId, {
          objectId: obj.status.objectId,
          type: obj.objectType,
          x: obj.status.pos.x,
          y: obj.status.pos.y,
          name: this.objectName(obj),
        });
        if (obj.objectType === PortalType.RealmPortal) {
          this.trackRealmPortal(obj.status);
        }
      }
    }
    for (const id of p.drops) {
      this.objects.delete(id);
      this.portals.delete(id);
    }
    this.maybeDumpObjects();
    this.findVaultPortal();
  }

  /** Drives each game tick: movement, status updates, portal use, and events. */
  private handleNewTick(p: NewTickPacket): void {
    if (this.stalled) {
      this.stallRecvTicks++;
    }
    const now = this.time();
    const dt = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
    this.lastFrameTime = now;
    this.updateTarget(dt);
    this.sendMove(p, now);
    this.updateStatuses(p);
    this.tryUseVaultPortal();
    //this.logAlive(p);
    this.emit(ClientEvent.Tick, this.player);
  }

  /** Advances the local position toward a requested movement target. */
  private updateTarget(dt: number): void {
    if (!this.target) {
      return;
    }
    this.stepToward(this.target, dt);
    this.detectMoveStall(dt);
    if (Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y) < this.target.threshold) {
      console.log(`${this.tag} reached move target`);
      this.moveStallMs = 0;
      this.moveBestDist = Infinity;
      const reached = { x: this.target.x, y: this.target.y };
      this.target = undefined;
      this.emit(ClientEvent.ReachedTarget, reached);
    }
  }

  /**
   * Warns when the server's position stops closing on the move target — i.e.
   * we're walking but the server won't let us (a nexus wall/obstacle blocking
   * the straight-line path). Pure diagnostics; does not alter control flow.
   */
  private detectMoveStall(dt: number): void {
    if (!this.target || !this.serverPos) {
      return;
    }
    const serverDist = Math.hypot(this.target.x - this.serverPos.x, this.target.y - this.serverPos.y);
    if (serverDist < this.moveBestDist - 0.1) {
      this.moveBestDist = serverDist;
      this.moveStallMs = 0;
      this.moveStallWarned = false;
      return;
    }
    this.moveStallMs += dt;
    if (this.moveStallMs > 3000 && !this.moveStallWarned) {
      this.moveStallWarned = true;
      console.warn(
        `${this.tag} ⚠ movement stalled — server stuck ${serverDist.toFixed(1)} tiles from target ` +
          `at (${this.serverPos.x.toFixed(2)},${this.serverPos.y.toFixed(2)}); likely a blocked path`,
      );
    }
  }

  /** Sends the MOVE packet required every tick to keep the client alive. */
  private sendMove(p: NewTickPacket, now: number): void {
    const move = new MovePacket();
    move.tickId = p.tickId;
    move.time = p.serverRealTimeMS;
    const record = new MoveRecord();
    record.time = now;
    record.x = this.pos.x;
    record.y = this.pos.y;
    move.records = [record]; // must send >= 1 record or the server drops us
    this.io.send(move);
  }

  /** Applies per-object status deltas from the tick to player and portal state. */
  private updateStatuses(p: NewTickPacket): void {
    for (const status of p.statuses) {
      if (status.objectId === this.objectId) {
        this.serverPos = { x: status.pos.x, y: status.pos.y };
        this.player = processObjectStatus(status, this.player);
      } else {
        const tracked = this.objects.get(status.objectId);
        if (tracked) {
          tracked.x = status.pos.x;
          tracked.y = status.pos.y;
        }
        if (this.portals.has(status.objectId)) {
          this.trackRealmPortal(status);
        }
      }
    }
  }

  /** Sends USE_PORTAL once the vault target has been reached. */
  private tryUseVaultPortal(): void {
    if (
      this.vaultPortalId === undefined ||
      this.target !== undefined ||
      this.inVault ||
      this.enteringVault ||
      this.usePortalAttempts >= 5 ||
      this.tickCount - this.lastUsePortalTick < 4
    ) {
      return;
    }
    const sp = this.serverPos;
    console.log(
      `${this.tag} → UsePortal(${this.vaultPortalId}) (attempt ${this.usePortalAttempts + 1}) ` +
        `local (${this.pos.x.toFixed(2)},${this.pos.y.toFixed(2)}) ` +
        `server ${sp ? `(${sp.x.toFixed(2)},${sp.y.toFixed(2)})` : '?'}`,
    );
    const use = new UsePortalPacket();
    use.objectId = this.vaultPortalId;
    this.io.send(use);
    this.lastUsePortalTick = this.tickCount;
    this.usePortalAttempts++;
  }

  /** Emits a periodic compact heartbeat with basic character state. */
  private logAlive(p: NewTickPacket): void {
    if (++this.tickCount % 30 !== 0) {
      return;
    }
    const stats = this.player
      ? `${parsePlayerClass(this.player.class)} lvl ${this.player.level} hp ${this.player.hp}/${this.player.maxHP}`
      : '';
    console.log(`${this.tag} alive — tick ${p.tickId}, pos (${this.pos.x.toFixed(1)}, ${this.pos.y.toFixed(1)}) ${stats}`);
  }

  /** Replies to server ping with the expected serial and current client time. */
  private handlePing(p: PingPacket): void {
    const pong = new PongPacket();
    pong.serial = p.serial;
    pong.time = this.time();
    this.io.send(pong);
  }

  /** Acknowledges our own server-authoritative projectile events. */
  private handleServerPlayerShoot(p: ServerPlayerShootPacket): void {
    if (p.ownerId !== this.objectId) {
      return;
    }
    const ack = new ShootAckPacket();
    ack.time = this.lastFrameTime;
    this.io.send(ack);
  }

  /** Acknowledges enemy projectile events so the server does not drop us. */
  private handleEnemyShoot(_p: EnemyShootPacket): void {
    const ack = new ShootAckPacket();
    ack.time = this.lastFrameTime;
    this.io.send(ack);
  }

  /** Acknowledges server position corrections. */
  private handleGoto(_p: GotoPacket): void {
    const ack = new GotoAckPacket();
    ack.time = this.lastFrameTime;
    this.io.send(ack);
  }

  /** Logs parsed vault storage sections and emits them for plugins. */
  private handleVaultContent(p: VaultContentPacket): void {
    this.inVault = true;
    const line = (label: string, slots: number[]): string => {
      const items = slots.filter((id) => id !== -1);
      const list = items.length ? ` → [${items.join(', ')}]` : '';
      return `${this.tag}    ${label}: ${slots.length} slots, ${items.length} items${list}`;
    };
    console.log(`${this.tag} 🏛  VAULT_CONTENT received:`);
    console.log(line('vault   ', p.vaultContents));
    console.log(line('material', p.materialContents));
    console.log(line('gift    ', p.giftContents));
    console.log(line('potion  ', p.potionContents));
    console.log(line('spoils  ', p.spoilsContents));
    this.emit(ClientEvent.VaultContents, p);
  }

  /** Tracks queue state while waiting for full maps. */
  private handleQueueInformation(p: QueueInfoPacket): void {
    this.inQueue = true;
    console.log(`${this.tag} in queue — position ${p.currentPosition}/${p.maxPosition}`);
  }

  /** Follows a server reconnect, preserving its destination game id and key. */
  private handleReconnect(p: ReconnectPacket): void {
    console.log(`${this.tag} reconnecting → ${p.host || this.host} (gameId ${p.gameId})`);
    this.clearMapState();
    this.clearNavState();
    this.enteringVault = true;
    if (p.host) this.host = p.host;
    if (p.port !== -1 && p.port !== 0) this.port = p.port;
    this.gameId = p.gameId;
    this.key = p.key;
    this.keyTime = p.keyTime;
    this.socket.destroy();
    setTimeout(() => this.connect(), 1000);
  }

  /** Logs server failure packets and schedules cooldown reconnects when needed. */
  private handleFailure(p: FailurePacket): void {
    console.error(`${this.tag} FAILURE ${p.errorId} (${this.describeFailure(p)}): ${p.errorDescription}`);
    this.emit(ClientEvent.Failure, p);
    if (/banned|abuse|too many/i.test(p.errorDescription)) {
      const mins = Math.round(config.rateLimitReconnectMs / 60000);
      console.error(`${this.tag} ⛔ rate-limited/banned — reconnecting in ${mins} min`);
      this.scheduleReconnect(config.rateLimitReconnectMs);
    }
  }

  /** Emits a death event for plugins and operators. */
  private handleDeath(p: DeathPacket): void {
    console.log(`${this.tag} 💀 died`);
    this.emit(ClientEvent.Death, p);
  }
}
