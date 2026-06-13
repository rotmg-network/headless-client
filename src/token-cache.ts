import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.resolve(process.cwd(), '.token-cache.json');

export interface CachedToken {
  accessToken: string;
  clientToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

type Cache = Record<string, CachedToken>;

function read(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * Returns the cached token for an account if it is still valid (with a 60s
 * safety margin), otherwise undefined.
 */
export function getCachedToken(guid: string): CachedToken | undefined {
  const entry = read()[guid];
  if (entry && entry.expiresAt > Date.now() + 60_000) {
    return entry;
  }
  return undefined;
}

/** Persists a token for an account. */
export function setCachedToken(guid: string, token: CachedToken): void {
  const cache = read();
  cache[guid] = token;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
