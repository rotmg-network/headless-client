import axios from 'axios';
import { createHash } from 'crypto';
import { ENDPOINTS, UNITY_HEADERS } from './constants';
import { getCachedToken, setCachedToken } from './token-cache';

export interface Account {
  guid: string;
  password: string;
  alias?: string;
}

export interface Credentials {
  accessToken: string;
  /** md5(guid + password) — sent as Hello.userToken. */
  clientToken: string;
}

export interface CharInfo {
  charId: number;
  needsNewChar: boolean;
}

export interface ServerInfo {
  name: string;
  address: string;
}

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

/**
 * Authenticates with the AppEngine and returns an access token. The token is
 * cached locally and reused until it expires, so /account/verify is only hit
 * when there is no valid cached token.
 */
export async function login(acc: Account): Promise<Credentials> {
  const clientToken = createHash('md5').update(acc.guid + acc.password).digest('hex');

  const cached = getCachedToken(acc.guid);
  if (cached) {
    const minsLeft = Math.round((cached.expiresAt - Date.now()) / 60000);
    console.log(`[${acc.alias ?? acc.guid}] using cached access token (expires in ${minsLeft}m)`);
    return { accessToken: cached.accessToken, clientToken: cached.clientToken };
  }

  const res = await axios.post<string>(
    ENDPOINTS.VERIFY,
    form({
      guid: acc.guid,
      password: acc.password,
      clientToken,
      game_net: 'Unity',
      play_platform: 'Unity',
      game_net_user_id: '',
    }),
    { headers: UNITY_HEADERS, responseType: 'text' },
  );
  const match = /<AccessToken>(.+?)<\/AccessToken>/.exec(res.data);
  if (!match) {
    throw new Error(`login failed: ${String(res.data).slice(0, 200)}`);
  }
  const accessToken = match[1];

  // Token lifetime comes from the response; fall back to ~50 minutes.
  const issued = Number(/<AccessTokenTimestamp>(\d+)<\/AccessTokenTimestamp>/.exec(res.data)?.[1] ?? '0');
  const lifetime = Number(/<AccessTokenExpiration>(\d+)<\/AccessTokenExpiration>/.exec(res.data)?.[1] ?? '0');
  const expiresAt = issued > 0 && lifetime > 0 ? (issued + lifetime) * 1000 : Date.now() + 50 * 60 * 1000;
  setCachedToken(acc.guid, { accessToken, clientToken, expiresAt });
  console.log(`[${acc.alias ?? acc.guid}] fetched new access token`);

  return { accessToken, clientToken };
}

/**
 * Fetches the character list and the embedded server list in one call.
 */
export async function getCharAndServers(
  accessToken: string,
): Promise<{ char: CharInfo; servers: ServerInfo[] }> {
  const res = await axios.post<string>(
    ENDPOINTS.CHAR_LIST,
    form({
      do_login: 'true',
      accessToken,
      game_net: 'Unity',
      play_platform: 'Unity',
      game_net_user_id: '',
    }),
    { headers: UNITY_HEADERS, responseType: 'text' },
  );
  const xml = res.data;
  if (xml.includes('Account in use')) {
    const secs = /Account in use.*?(\d+)/.exec(xml)?.[1];
    throw new Error(`account in use${secs ? ` (retry in ${secs}s)` : ''}`);
  }
  if (xml.includes('Account credentials not valid')) {
    throw new Error('account credentials not valid');
  }

  const nextCharId = Number(/<Chars nextCharId="(\d+)"/.exec(xml)?.[1] ?? '1');
  const charIds = [...xml.matchAll(/<Char id="(\d+)">/g)].map((m) => Number(m[1]));
  const char: CharInfo =
    charIds.length > 0
      ? { charId: charIds[0], needsNewChar: false }
      : { charId: nextCharId, needsNewChar: true };

  const servers: ServerInfo[] = [];
  for (const block of xml.matchAll(/<Server>([\s\S]*?)<\/Server>/g)) {
    const name = /<Name>(.*?)<\/Name>/.exec(block[1])?.[1];
    const dns = /<DNS>(.*?)<\/DNS>/.exec(block[1])?.[1];
    if (name && dns) {
      servers.push({ name, address: dns });
    }
  }

  return { char, servers };
}
