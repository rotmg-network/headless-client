import * as net from 'net';
import {
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
  RawPacket,
  PlayerData,
  processObjectStatus,
  hexdump,
} from 'realmlib';
import { BUILD_VERSION, GAME_ID, GAME_PORT, HELLO_TOKEN } from './constants';

export interface ClientOptions {
  alias: string;
  accessToken: string;
  clientToken: string;
  charId: number;
  needsNewChar: boolean;
  host: string;
}

/**
 * A minimal headless client: logs in, completes the Hello handshake, and
 * runs the keep-alive loop (Move / Pong / UpdateAck / ShootAck) so the
 * account connects and stays in-world.
 */
export class Client {
  private socket!: net.Socket;
  private io!: PacketIO;

  private host: string;
  private port = GAME_PORT;
  private gameId = GAME_ID.NEXUS;
  private key: number[] = [];
  private keyTime = -1;

  private objectId = -1;
  private pos = { x: 0, y: 0 };
  private posKnown = false;
  private connectStart = 0;
  private lastFrameTime = 0;
  private tickCount = 0;
  private readonly seenUnknown = new Set<number>();
  private player: PlayerData | undefined;
  private inQueue = false;

  constructor(private readonly opts: ClientOptions) {
    this.host = opts.host;
  }

  private get tag(): string {
    return `[${this.opts.alias}]`;
  }

  private time(): number {
    return Date.now() - this.connectStart;
  }

  connect(): void {
    this.socket = new net.Socket();
    this.io = new PacketIO({ socket: this.socket }); // realmlib supplies the packet map
    this.io.setMaxListeners(0);
    this.io.on('error', (err: Error) => console.error(`${this.tag} io error:`, err.message));
    this.registerHandlers();
    this.setupDebug();

    this.socket.on('connect', () => {
      this.connectStart = Date.now();
      console.log(`${this.tag} socket connected → sending Hello (gameId ${this.gameId})`);
      this.sendHello();
    });
    this.socket.on('close', () => console.log(`${this.tag} socket closed`));
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
      if (this.inQueue) {
        console.log(`${this.tag} cleared queue — entering`);
        this.inQueue = false;
      }
      console.log(`${this.tag} ✓ MapInfo accepted: "${p.name}" (${p.width}x${p.height})`);
      if (this.opts.needsNewChar) {
        const create = new CreatePacket();
        create.classType = 768; // Wizard
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
          this.player = processObjectStatus(obj.status, this.player);
        }
      }
    });

    this.io.on(PacketType.NEWTICK, (p: NewTickPacket) => {
      this.lastFrameTime = this.time();
      const move = new MovePacket();
      move.tickId = p.tickId;
      move.time = p.serverRealTimeMS;
      const record = new MoveRecord();
      record.time = this.lastFrameTime;
      record.x = this.pos.x;
      record.y = this.pos.y;
      move.records = [record]; // must send >= 1 record or the server drops us
      this.io.send(move);

      for (const status of p.statuses) {
        if (status.objectId === this.objectId) {
          this.player = processObjectStatus(status, this.player);
        }
      }

      if (++this.tickCount % 30 === 0) {
        const hp = this.player ? `hp ${this.player.hp}/${this.player.maxHP} lvl ${this.player.level}` : '';
        console.log(
          `${this.tag} alive — tick ${p.tickId}, pos (${this.pos.x.toFixed(1)}, ${this.pos.y.toFixed(1)}) ${hp}`,
        );
      }
    });

    this.io.on(PacketType.PING, (p: PingPacket) => {
      const pong = new PongPacket();
      pong.serial = p.serial;
      pong.time = this.time();
      this.io.send(pong);
    });

    this.io.on(PacketType.SERVERPLAYERSHOOT, (_p: ServerPlayerShootPacket) => {
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

    // Server is full: it places us in a queue and streams position updates.
    // We stay connected and wait — MapInfo arrives once we're through. No
    // game packets are sent meanwhile (NewTick/Update only come after entry).
    this.io.on(PacketType.QUEUE_INFORMATION, (p: QueueInfoPacket) => {
      this.inQueue = true;
      console.log(`${this.tag} in queue — position ${p.currentPosition}/${p.maxPosition}`);
    });

    this.io.on(PacketType.RECONNECT, (p: ReconnectPacket) => {
      console.log(`${this.tag} reconnect → ${p.host || this.host} (gameId ${p.gameId})`);
      if (p.host) this.host = p.host;
      if (p.port !== -1 && p.port !== 0) this.port = p.port;
      this.gameId = p.gameId;
      this.key = p.key;
      this.keyTime = p.keyTime;
      this.posKnown = false;
      this.socket.destroy();
      setTimeout(() => this.connect(), 1000);
    });

    this.io.on(PacketType.FAILURE, (p: FailurePacket) => {
      console.error(`${this.tag} FAILURE ${p.errorId}: ${p.errorDescription}`);
      if (/banned|abuse|too many/i.test(p.errorDescription)) {
        console.error(`${this.tag} ⛔ rate-limited/banned by the server — back off before retrying`);
      }
    });
  }
}
