/**
 * AppEngine HTTP endpoints used during login.
 */
export const ENDPOINTS = {
  VERIFY: 'https://www.realmofthemadgod.com/account/verify',
  VERIFY_TOKEN: 'https://www.realmofthemadgod.com/account/verifyAccessTokenClient',
  CHAR_LIST: 'https://www.realmofthemadgod.com/char/list',
  SERVERS: 'https://www.realmofthemadgod.com/account/servers',
};

/**
 * Headers that make the AppEngine treat the request as the real Unity client.
 */
export const UNITY_HEADERS = {
  'User-Agent': 'UnityPlayer/2021.3.16f1 (UnityWebRequest/1.0, libcurl/7.84.0-DEV)',
  'X-Unity-Version': '2021.3.16f1',
  'Content-Type': 'application/x-www-form-urlencoded',
};

/**
 * Known map ids accepted in the Hello packet. Negative ids are special maps;
 * realm instances and portal reconnects use server-assigned ids.
 */
export enum GameId {
  Tutorial = -1,
  Nexus = -2,
  RandomRealm = -3,
  NexusTutorial = -4,
  Vault = -5,
  MapTest = -6,
  VaultExplanation = -8,
  NexusExplanation = -9,
  QuestRoom = -11,
  CheatersQuarantine = -13,
}

/**
 * Backwards-compatible aliases for older client code.
 */
export const GAME_ID = {
  NEXUS: GameId.Nexus,
  TUTORIAL: GameId.Tutorial,
};

/**
 * The game build version sent in Hello. Must match what the live servers
 * expect; if the server replies with a version-mismatch failure, bump this.
 * Sourced from the current working client (pyrelay).
 */
export const BUILD_VERSION = '6.11.0.0.0';

/**
 * Constant client token baked into the current Unity build, sent as the
 * final Hello field.
 */
export const HELLO_TOKEN = 'XQpu8CWkMehb5rLVP3DG47FcafExRUvg';

/**
 * The TCP port game servers listen on.
 */
export const GAME_PORT = 2050;
