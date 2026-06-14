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
  VaultContentPacket,
  EscapePacket,
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
  ChatToken,
  PortalType,
  TextPacket,
} from 'realmlib';
import { BUILD_VERSION, GAME_ID, GAME_PORT, HELLO_TOKEN } from './constants';
import { config } from './config';
import { RealmPortal, ClientOptions } from './models'


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
  private connectStart = 0;
  private lastFrameTime = 0;
  private tickCount = 0;
  private readonly seenUnknown = new Set<number>();
  private player: PlayerData | undefined;
  private inQueue = false;

  // Navigation / vault state
  private wantVault = false;
  private readonly objects = new Map<number, { type: number; x: number; y: number; name?: string }>();
  private readonly portals = new Map<number, RealmPortal>();
  private vaultPortalId: number | undefined;
  private target: { x: number; y: number } | undefined;
  private enteringVault = false;
  private inVault = false;
  private dumped = false;
  private lastUsePortalTick = -100;
  private usePortalAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Movement speed multipliers
  private static readonly SPEED_MIN = 0.004;
  private static readonly SPEED_MAX = 0.0096;

  constructor(private readonly opts: ClientOptions) {
    super();
    this.setMaxListeners(0); // plugins may add many listeners
    this.host = opts.host;
    this.wantVault = opts.autoEnterVault ?? config.autoEnterVault;
  }

  //#region plugin-facing surface

  /** Hooks an incoming packet type. realmlib starts parsing the type on demand. */
  onPacket<T extends Packet>(type: PacketType, handler: (packet: T) => void): this {
    if (!this.subscribedPacketTypes.has(type)) {
      this.subscribedPacketTypes.add(type);
      // Bridge io -> this for the type if already connected; otherwise
      // registerHandlers() will bridge it on (re)connect.
      this.bridgePacket(type);
    }
    return this.on(type, handler as (packet: Packet) => void);
  }

  /** Sends a packet to the server. */
  send(packet: Packet): void {
    this.io?.send(packet);
  }

  /** Walks the player toward a position (cleared on arrival, emits 'reachedTarget'). */
  moveTo(target: { x: number; y: number }): void {
    this.target = { x: target.x, y: target.y };
  }

  get alias(): string {
    return this.opts.alias;
  }
  getPlayer(): PlayerData | undefined {
    return this.player;
  }
  getPosition(): { x: number; y: number } {
    return { x: this.pos.x, y: this.pos.y };
  }
  getObjectId(): number {
    return this.objectId;
  }
  isInVault(): boolean {
    return this.inVault;
  }

  /** The realm portals currently tracked in the nexus. */
  realmPortals(): RealmPortal[] {
    return [...this.portals.values()];
  }

  //#endregion

  /** Bridges an io packet emission onto this client's emitter (for the current io). */
  private bridgePacket(type: PacketType): void {
    this.io?.on(type, (packet: Packet) => this.emit(type, packet));
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

  private get tag(): string {
    return `[${this.opts.alias}]`;
  }

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
    for (const stat of status.stats) {
      if (stat.statType === StatType.NAME_STAT) {
        rawName = stat.stringStatValue;
      } else if (stat.statType === StatType.OPENED_AT_TIMESTAMP) {
        openedAt = stat.statValue;
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
    };
    this.portals.set(status.objectId, portal);
    if (!previous) {
      console.log(
        `${this.tag} realm portal: ${parsed.name} (${parsed.players}/${parsed.maxPlayers}) opened ${openedAt ?? '?'}`,
      );
    }
    this.emit('realmPortal', portal);
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

  /** Moves `pos` toward `target` by the distance the player can cover in `dt` ms. */
  private stepToward(target: { x: number; y: number }, dt: number): void {
    const spd = (this.player?.spd ?? 0) + (this.player?.spdBoost ?? 0);
    const tilesPerMs = Client.SPEED_MIN + (spd / 75) * (Client.SPEED_MAX - Client.SPEED_MIN);
    const step = tilesPerMs * dt;
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      this.pos = { x: target.x, y: target.y };
    } else {
      this.pos = { x: this.pos.x + (dx / dist) * step, y: this.pos.y + (dy / dist) * step };
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
        this.target = { x: o.x, y: o.y };
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

  connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer); // a (re)connect cancels any pending scheduled one
      this.reconnectTimer = undefined;
    }
    this.socket = new net.Socket();
    this.io = new PacketIO({ socket: this.socket });
    this.io.setMaxListeners(0);
    this.io.on('error', (err: Error) => console.error(`${this.tag} io error:`, err.message));
    this.registerHandlers();
    this.setupDebug();

    this.socket.on('connect', () => {
      this.connectStart = Date.now();
      console.log(`${this.tag} socket connected → sending Hello (gameId ${this.gameId})`);
      this.sendHello();
      this.emit('connected');
    });
    this.socket.on('close', () => {
      console.log(`${this.tag} socket closed`);
      this.emit('disconnect');
    });
    this.socket.on('error', (err) => console.error(`${this.tag} socket error:`, err.message));

    console.log(`${this.tag} connecting to ${this.host}:${this.port}`);
    this.socket.connect(this.port, this.host);
  }

  /**
   * Wires up packet debugging. Unknown packet ids are always reported once.
   * Set DEBUG_PACKETS to inspect traffic:
   *   types   — log every incoming packet type
   *   hex     — log every type and hexdump its payload
   *   unknown — log + hexdump only packets with no mapped type
   */
  private setupDebug(): void {
    this.io.on('unknownPacket', ({ id, size }: { id: number; size: number }) => {
      if (this.seenUnknown.has(id)) {
        return;
      }
      this.seenUnknown.add(id);
      console.log(`${this.tag} ⚠ unknown packet id ${id} (${size}b) — not in packet map`);
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

  private registerHandlers(): void {
    this.io.on(PacketType.MAPINFO, (p: MapInfoPacket) => {
      console.log(`${this.tag} ✓ MapInfo accepted: "${p.name}" (${p.width}x${p.height})`);
      // Arrived on a new map: the transition is complete, set the vault flag.
      this.enteringVault = false;
      this.inVault = /vault/i.test(p.name);
      // handle client in a server queue.
      if (this.inQueue) {
        console.log(`${this.tag} cleared queue — entering`);
        this.inQueue = false;
      }
      this.emit('mapChange', p.name);
      if (this.inVault) {
        console.log(`${this.tag} entered Vault`);
        this.emit('enterVault');
      } else if (p.name == 'Nexus') {
        console.log(`${this.tag} entered Nexus`);
        this.emit('enterNexus');
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
    });

    this.io.on(PacketType.CREATE_SUCCESS, (p: CreateSuccessPacket) => {
      this.objectId = p.objectId;
      this.lastFrameTime = this.time();
      console.log(`${this.tag} ✓✓ IN-WORLD as objectId ${p.objectId}`);
      // the real client enables ally-projectile visibility on entry.
      const show = new ShowAllyShootPacket();
      show.toggle = 1;
      this.io.send(show);
      this.emit('ready', p.objectId);
    });

    this.io.on(PacketType.UPDATE, (p: UpdatePacket) => {
      this.io.send(new UpdateAckPacket());
      if (!this.posKnown && p.pos) {
        this.pos = { x: p.pos.x, y: p.pos.y };
        this.posKnown = true;
      }
      for (const obj of p.newObjects) {
        if (obj.status.objectId === this.objectId) {
          this.pos = { x: obj.status.pos.x, y: obj.status.pos.y };
          this.posKnown = true;
          // processObject captures the class (object type); NewTick only carries stats.
          this.player = processObject(obj);
        } else {
          // set new or update ObjectData.
          this.objects.set(obj.status.objectId, {
            type: obj.objectType,
            x: obj.status.pos.x,
            y: obj.status.pos.y,
            name: this.objectName(obj),
          });
          // Track realm portals so we know which realms are open and how full.
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
    });

    this.io.on(PacketType.NEWTICK, (p: NewTickPacket) => {
      const now = this.time();
      const dt = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
      this.lastFrameTime = now;

      // Walk toward the current target; clear it once we're on it.
      if (this.target) {
        this.stepToward(this.target, dt);
        if (Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y) < config.arriveThreshold) {
          console.log(`${this.tag} reached move target`);
          const reached = this.target;
          this.target = undefined;
          this.emit('reachedTarget', reached);
        }
      }

      const move = new MovePacket();
      move.tickId = p.tickId;
      move.time = p.serverRealTimeMS;
      const record = new MoveRecord();
      record.time = now;
      record.x = this.pos.x;
      record.y = this.pos.y;
      move.records = [record]; // must send >= 1 record or the server drops us
      this.io.send(move);

      for (const status of p.statuses) {
        if (status.objectId === this.objectId) {
          this.player = processObjectStatus(status, this.player);
        } else if (this.portals.has(status.objectId)) {
          // Keep realm portal player counts current as they change.
          this.trackRealmPortal(status);
        }
      }

      // On the portal (target cleared, Move already sent so the server knows
      // we're here): use it, retrying until it reconnects us to the vault.
      if (
        this.vaultPortalId !== undefined &&
        this.target === undefined &&
        !this.inVault &&
        !this.enteringVault &&
        this.usePortalAttempts < 5 &&
        this.tickCount - this.lastUsePortalTick >= 4
      ) {
        console.log(`${this.tag} → UsePortal(${this.vaultPortalId}) (attempt ${this.usePortalAttempts + 1})`);
        const use = new UsePortalPacket();
        use.objectId = this.vaultPortalId;
        this.io.send(use);
        this.lastUsePortalTick = this.tickCount;
        this.usePortalAttempts++;
      }

      if (++this.tickCount % 30 === 0) {
        const stats = this.player
          ? `${parsePlayerClass(this.player.class)} lvl ${this.player.level} hp ${this.player.hp}/${this.player.maxHP}`
          : '';
        console.log(
          `${this.tag} alive — tick ${p.tickId}, pos (${this.pos.x.toFixed(1)}, ${this.pos.y.toFixed(1)}) ${stats}`,
        );
      }
      this.emit('tick', this.player);
    });

    this.io.on(PacketType.PING, (p: PingPacket) => {
      const pong = new PongPacket();
      pong.serial = p.serial;
      pong.time = this.time();
      this.io.send(pong);
    });

    this.io.on(PacketType.SERVERPLAYERSHOOT, (p: ServerPlayerShootPacket) => {
      // Only acknowledge our own shots, as the real client does.
      if (p.ownerId !== this.objectId) {
        return;
      }
      const ack = new ShootAckPacket();
      ack.time = this.lastFrameTime;
      this.io.send(ack);
    });
  
    this.io.on(PacketType.ENEMYSHOOT, (_p: EnemyShootPacket) => {
      const ack = new ShootAckPacket();
      ack.time = this.lastFrameTime;
      this.io.send(ack);
    });

    this.io.on(PacketType.GOTO, () => {
      const ack = new GotoAckPacket();
      ack.time = this.lastFrameTime;
      this.io.send(ack);
    });

    this.io.on(PacketType.VAULT_CONTENT, (p: VaultContentPacket) => {
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
      this.emit('vaultContents', p);
    });

    // Server is full: it places us in a queue and streams position updates.
    // We stay connected and wait — MapInfo arrives once we're through. No
    // game packets are sent meanwhile (NewTick/Update only come after entry).
    this.io.on(PacketType.QUEUE_INFORMATION, (p: QueueInfoPacket) => {
      this.inQueue = true;
      console.log(`${this.tag} in queue — position ${p.currentPosition}/${p.maxPosition}`);
    });

    this.io.on(PacketType.RECONNECT, (p: ReconnectPacket) => {
      console.log(`${this.tag} reconnect → ${p.host || this.host} (gameId ${p.gameId})`);
      this.clearMapState(); // we're loading a new map; drop the old objects/portals
      this.clearNavState();
      this.enteringVault = true; // stop any UsePortal attempts; we're transitioning
      if (p.host) this.host = p.host;
      if (p.port !== -1 && p.port !== 0) this.port = p.port;
      this.gameId = p.gameId;
      this.key = p.key;
      this.keyTime = p.keyTime;
      this.socket.destroy();
      setTimeout(() => this.connect(), 1000);
    });

    this.io.on(PacketType.FAILURE, (p: FailurePacket) => {
      console.error(`${this.tag} FAILURE ${p.errorId} (${this.describeFailure(p)}): ${p.errorDescription}`);
      this.emit('failure', p);
      if (/banned|abuse|too many/i.test(p.errorDescription)) {
        const mins = Math.round(config.rateLimitReconnectMs / 60000);
        console.error(`${this.tag} ⛔ rate-limited/banned — reconnecting in ${mins} min`);
        this.scheduleReconnect(config.rateLimitReconnectMs);
      }
    });

    this.io.on(PacketType.TEXT, (_p: TextPacket) => {
      //console.log(`[chat] [${p.name}] [${p.numStars}] ${p.text}`)
    });

    this.io.on(PacketType.CHATTOKEN, (p: ChatToken) => {
      console.log(`${this.tag} ⚠️ received ChatToken packet - token: ${p.token} - host: ${p.host} - port: ${p.port}`)
    });

    this.io.on(PacketType.DEATH, (p: DeathPacket) => {
      console.log(`${this.tag} 💀 died`);
      this.emit('death', p);
    });

    // Re-attach plugin packet hooks: bridge every subscribed type onto this io.
    for (const type of this.subscribedPacketTypes) {
      this.bridgePacket(type);
    }
  }
}
