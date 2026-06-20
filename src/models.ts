/** A realm portal in the nexus, parsed from its NAME stat. */
export interface RealmPortal {
  objectId: number;
  /** The realm name, e.g. "Horizon". */
  name: string;
  /** Players currently in the realm. */
  players: number;
  /** Maximum players the realm holds. */
  maxPlayers: number;
  /** Server timestamp at which the realm opened. */
  openedAt: number;
  x: number;
  y: number;
}

/** A visible object tracked from UPDATE/NEWTICK state. */
export interface TrackedObject {
  objectId: number;
  type: number;
  x: number;
  y: number;
  name?: string;
}

/** Game server metadata from /char/list. */
export interface ClientServer {
  name: string;
  address: string;
}

/** Configuration for each Client. */
export interface ClientOptions {
  alias: string;
  accessToken: string;
  clientToken: string;
  charId: number;
  needsNewChar: boolean;
  host: string;
  /** Full server list known when the client was created. */
  servers?: ClientServer[];
  /** Walk into the vault automatically once in the nexus. */
  autoEnterVault?: boolean;
}
