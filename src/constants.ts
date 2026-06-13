/**
 * AppEngine HTTP endpoints used during login.
 */
export const ENDPOINTS = {
  VERIFY: 'https://www.realmofthemadgod.com/account/verify',
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
 * Special map ids used in the Hello packet.
 */
export const GAME_ID = {
  NEXUS: -2,
  TUTORIAL: -1,
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
