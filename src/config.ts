/**
 * Global, runtime-mutable configuration. A single shared object that every
 * client reads from live — mutate it while the program is running (e.g. via
 * the console in index.ts) and the change takes effect on the next use.
 */
export interface AppConfig {
  /** Delay before reconnecting after a rate-limit / ban, in milliseconds. */
  rateLimitReconnectMs: number;
  /** Default for walking into the vault on reaching the nexus (per-account `enterVault` overrides). */
  autoEnterVault: boolean;
  /** How close (in tiles) to a navigation target before it counts as reached. */
  arriveThreshold: number;
}

export const config: AppConfig = {
  rateLimitReconnectMs: 5 * 60 * 1000,
  autoEnterVault: false,
  arriveThreshold: 0.5,
};

/**
 * Updates a config key from a string (e.g. console input), coercing to the
 * existing field's type. Returns true if the key exists and the value applied.
 */
export function setConfig(key: string, raw: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(config, key)) {
    return false;
  }
  const store = config as unknown as Record<string, unknown>;
  const current = store[key];
  if (typeof current === 'number') {
    const value = Number(raw);
    if (Number.isNaN(value)) {
      return false;
    }
    store[key] = value;
  } else if (typeof current === 'boolean') {
    store[key] = raw === 'true' || raw === '1';
  } else {
    store[key] = raw;
  }
  return true;
}
