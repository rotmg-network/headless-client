import { FailurePacket, MapInfoPacket } from 'realmlib';
import { Client } from '../client';
import { GameId } from '../constants';
import { ClientEvent } from '../events';
import { EventHook, PacketHook, Plugin } from './decorators';

type GameIdStatus = 'pending' | 'mapinfo' | 'ready' | 'failure' | 'timeout';

export interface GameIdCheckResult {
  gameId: number;
  label: string;
  known: boolean;
  status: GameIdStatus;
  mapName?: string;
  width?: number;
  height?: number;
  objectId?: number;
  failureCode?: number;
  error?: string;
}

interface GameIdCandidate {
  gameId: number;
  label: string;
  known: boolean;
}

const DEFAULT_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Probes known and nearby undocumented Hello game ids, recording which ids
 * produce MapInfo and which fully load into the world.
 */
@Plugin({
  name: 'GameIdChecker',
  description: 'Tests known and candidate Hello game ids for valid map connections.',
  author: 'realmlib',
  version: '1.0.0',
})
export class GameIdChecker {
  private readonly candidates = buildCandidates();
  private readonly results = new Map<number, GameIdCheckResult>();
  private readonly delayMs = readPositiveInt('GAME_ID_CHECK_DELAY_MS', DEFAULT_DELAY_MS);
  private readonly timeoutMs = readPositiveInt('GAME_ID_CHECK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  private current: GameIdCandidate | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private running = false;
  private lastMapName = '';

  /** Starts scanning after the first normal Nexus load completes. */
  @EventHook(ClientEvent.Ready)
  onReady(client: Client, objectId: number): void {
    if (this.current) {
      this.completeCurrent(client, { status: 'ready', objectId });
      return;
    }
    if (!this.started && this.lastMapName === 'Nexus') {
      this.start(client);
    }
  }

  /** Captures MapInfo details for the active candidate before LOAD completes. */
  @PacketHook()
  onMapInfo(_client: Client, packet: MapInfoPacket): void {
    this.lastMapName = packet.name;
    if (!this.current) {
      return;
    }
    this.upsertResult(this.current, {
      status: 'mapinfo',
      mapName: packet.name,
      width: packet.width,
      height: packet.height,
    });
  }

  /** Records server failures for the active candidate and moves on. */
  @EventHook(ClientEvent.Failure)
  onFailure(client: Client, packet: FailurePacket): void {
    if (!this.current) {
      return;
    }
    const shouldStop = /banned|abuse|too many/i.test(packet.errorDescription);
    this.completeCurrent(client, {
      status: 'failure',
      failureCode: packet.errorId,
      error: packet.errorDescription,
    });
    if (shouldStop) {
      this.stop();
      console.error(`[${client.alias}] GameIdChecker: stopped after rate-limit failure`);
    }
  }

  /** Starts the probe run if it has not already started. */
  start(client: Client): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.running = true;
    console.log(
      `[${client.alias}] GameIdChecker: testing ${this.candidates.length} game ids ` +
        `(${this.delayMs}ms delay, ${this.timeoutMs}ms timeout)`,
    );
    this.scheduleNext(client, 0);
  }

  /** Stops the current run without clearing collected results. */
  stop(): void {
    this.running = false;
    this.current = undefined;
    this.clearTimer();
  }

  /** All collected results in candidate order. */
  checks(): GameIdCheckResult[] {
    return this.candidates.map((candidate) => this.resultFor(candidate));
  }

  /** Picks the next pending candidate and reconnects the client to test it. */
  private runNext(client: Client): void {
    if (!this.running) {
      return;
    }
    const next = this.candidates.find((candidate) => this.resultFor(candidate).status === 'pending');
    if (!next) {
      this.finish(client);
      return;
    }

    this.current = next;
    this.upsertResult(next, { status: 'pending' });
    console.log(`[${client.alias}] GameIdChecker: probing ${next.label} (${next.gameId})`);
    client.connectToGameId(next.gameId);
    this.timer = setTimeout(() => {
      if (this.current?.gameId === next.gameId) {
        this.completeCurrent(client, { status: 'timeout', error: `no Ready within ${this.timeoutMs}ms` });
      }
    }, this.timeoutMs);
  }

  /** Finalizes the active candidate with the latest observed outcome. */
  private completeCurrent(client: Client, update: Partial<GameIdCheckResult>): void {
    if (!this.current) {
      return;
    }
    const candidate = this.current;
    this.upsertResult(candidate, update);
    const result = this.resultFor(candidate);
    console.log(
      `[${client.alias}] GameIdChecker: ${candidate.label} (${candidate.gameId}) -> ` +
        `${result.status}${result.mapName ? ` "${result.mapName}"` : ''}${result.error ? ` (${result.error})` : ''}`,
    );
    this.current = undefined;
    this.clearTimer();
    this.scheduleNext(client, this.delayMs);
  }

  /** Defers the next probe to avoid rapid reconnect loops. */
  private scheduleNext(client: Client, delayMs: number): void {
    setTimeout(() => this.runNext(client), delayMs);
  }

  /** Stops scanning and prints a compact results table. */
  private finish(client: Client): void {
    this.running = false;
    this.current = undefined;
    this.clearTimer();
    const rows = this.checks();
    console.log(`[${client.alias}] GameIdChecker: complete`);
    console.table(
      rows.map((row) => ({
        gameId: row.gameId,
        label: row.label,
        known: row.known,
        status: row.status,
        map: row.mapName ?? '',
        size: row.width && row.height ? `${row.width}x${row.height}` : '',
        error: row.error ?? '',
      })),
    );
    client.connectToGameId(GameId.Nexus);
  }

  /** Returns a stored result or a pending placeholder for display. */
  private resultFor(candidate: GameIdCandidate): GameIdCheckResult {
    return (
      this.results.get(candidate.gameId) ?? {
        gameId: candidate.gameId,
        label: candidate.label,
        known: candidate.known,
        status: 'pending',
      }
    );
  }

  /** Merges a partial result update into the current result map. */
  private upsertResult(candidate: GameIdCandidate, update: Partial<GameIdCheckResult>): void {
    const previous = this.resultFor(candidate);
    this.results.set(candidate.gameId, { ...previous, ...update });
  }

  /** Clears the active per-candidate timeout. */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** Builds the scan list: known enum ids, nearby undocumented gaps, and opt-in extras. */
function buildCandidates(): GameIdCandidate[] {
  const known = Object.entries(GameId)
    .filter(([, value]) => typeof value === 'number')
    .map(([label, value]) => ({ gameId: value as number, label, known: true }));
  const seen = new Set(known.map((candidate) => candidate.gameId));
  const gapCandidates = range(-13, -1)
    .filter((gameId) => !seen.has(gameId))
    .map((gameId) => ({ gameId, label: `Undocumented${gameId}`, known: false }));
  for (const candidate of gapCandidates) {
    seen.add(candidate.gameId);
  }
  const extraCandidates = parseExtraCandidates(process.env.GAME_ID_CHECK_EXTRA, seen)
    .map((gameId) => ({ gameId, label: `Extra${gameId}`, known: false }));

  return [...known, ...gapCandidates, ...extraCandidates].sort((a, b) => a.gameId - b.gameId);
}

/** Parses GAME_ID_CHECK_EXTRA values like "-20:-14,-12,0,1". */
function parseExtraCandidates(raw: string | undefined, existing: Set<number>): number[] {
  if (!raw) {
    return [];
  }
  const values: number[] = [];
  const seen = new Set(existing);
  for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const rangeMatch = /^(-?\d+):(-?\d+)$/.exec(part);
    const parsed = rangeMatch ? range(Number(rangeMatch[1]), Number(rangeMatch[2])) : [Number(part)];
    for (const gameId of parsed) {
      if (!Number.isInteger(gameId) || seen.has(gameId)) {
        continue;
      }
      seen.add(gameId);
      values.push(gameId);
    }
  }
  return values;
}

/** Inclusive numeric range helper that supports ascending and descending ranges. */
function range(start: number, end: number): number[] {
  const step = start <= end ? 1 : -1;
  const values: number[] = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
    values.push(value);
  }
  return values;
}

/** Reads a positive integer environment variable with a sane fallback. */
function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
