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
} from 'realmlib';
import { PACKET_MAP } from './packet-map';
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
    this.io = new PacketIO({ socket: this.socket, packetMap: PACKET_MAP });
    this.io.setMaxListeners(0);
    this.io.on('error', (err: Error) => console.error(`${this.tag} io error:`, err.message));
    this.registerHandlers();

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

      if (++this.tickCount % 30 === 0) {
        console.log(`${this.tag} alive — tick ${p.tickId}, pos (${this.pos.x.toFixed(1)}, ${this.pos.y.toFixed(1)})`);
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

    this.io.on(PacketType.QUEUE_INFORMATION, (p: QueueInfoPacket) => {
      console.log(`${this.tag} login queue ${p.currentPosition}/${p.maxPosition}`);
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
    });
  }
}
