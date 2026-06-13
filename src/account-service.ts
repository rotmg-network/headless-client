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

export type AppEngineErrorKind = 'credentials' | 'account_in_use' | 'token_invalid' | 'unknown';

/**
 * An error returned by the AppEngine HTTP API, classified into a known kind.
 */
export class AppEngineError extends Error {
  constructor(
    message: string,
    readonly kind: AppEngineErrorKind,
    /** The raw `<Error>` text from the server. */
    readonly detail: string,
    /** Seconds until the account-in-use lock clears, if known. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppEngineError';
  }
}

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

const UNITY_FIELDS = { game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' };

/** POSTs a form to the AppEngine and returns the body, without throwing on non-2xx. */
async function postForm(url: string, data: Record<string, string>): Promise<string> {
  const res = await axios.post<string>(url, form(data), {
    headers: UNITY_HEADERS,
    responseType: 'text',
    validateStatus: () => true,
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

/** Classifies an `<Error>...</Error>` response, or returns undefined if there is none. */
function classifyError(xml: string): AppEngineError | undefined {
  const raw = /<Error[^>]*>([\s\S]*?)<\/Error>/.exec(xml)?.[1]?.trim();
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  if (lower.includes('account in use')) {
    const secs = /(\d+)/.exec(raw)?.[1];
    return new AppEngineError(
      `account in use${secs ? ` (locked ~${secs}s)` : ''}`,
      'account_in_use',
      raw,
      secs ? Number(secs) : undefined,
    );
  }
  if (
    lower.includes('credentials not valid') ||
    lower.includes('passworderror') ||
    lower.includes('incorrect')
  ) {
    return new AppEngineError('invalid email or password', 'credentials', raw);
  }
  return new AppEngineError(raw, 'unknown', raw);
}

/**
 * Validates an access token against the dedicated verification endpoint.
 * Returns true on "Success", false if the token is not valid. Throws on an
 * account-in-use lock.
 */
async function verifyAccessToken(accessToken: string, clientToken: string): Promise<boolean> {
  const xml = await postForm(ENDPOINTS.VERIFY_TOKEN, { clientToken, accessToken, ...UNITY_FIELDS });
  if (xml.includes('Success')) {
    return true;
  }
  const error = classifyError(xml);
  if (error && error.kind === 'account_in_use') {
    throw error;
  }
  return false;
}

/**
 * Authenticates with the AppEngine and returns a verified access token. A
 * cached token is reused (and re-validated against the verify endpoint) until
 * it expires; otherwise /account/verify is called and the resulting token is
 * verified before use.
 *
 * @throws {AppEngineError} for bad credentials, account-in-use, or token issues.
 */
export async function login(acc: Account): Promise<Credentials> {
  const tag = acc.alias ?? acc.guid;
  const clientToken = createHash('md5').update(acc.guid + acc.password).digest('hex');

  const cached = getCachedToken(acc.guid);
  if (cached && (await verifyAccessToken(cached.accessToken, clientToken))) {
    const minsLeft = Math.round((cached.expiresAt - Date.now()) / 60000);
    console.log(`[${tag}] using cached access token (verified, expires in ${minsLeft}m)`);
    return { accessToken: cached.accessToken, clientToken: cached.clientToken };
  }
  if (cached) {
    console.log(`[${tag}] cached token rejected — re-authenticating`);
  }

  const xml = await postForm(ENDPOINTS.VERIFY, {
    guid: acc.guid,
    password: acc.password,
    clientToken,
    ...UNITY_FIELDS,
  });
  const verifyError = classifyError(xml);
  if (verifyError) {
    throw verifyError;
  }
  const match = /<AccessToken>(.+?)<\/AccessToken>/.exec(xml);
  if (!match) {
    throw new AppEngineError('no access token in verify response', 'unknown', xml.slice(0, 200));
  }
  const accessToken = match[1];

  // Verify the freshly issued token via the dedicated endpoint before using it.
  if (!(await verifyAccessToken(accessToken, clientToken))) {
    throw new AppEngineError('access token failed verification', 'token_invalid', '');
  }

  // Token lifetime comes from the response; fall back to ~50 minutes.
  const issued = Number(/<AccessTokenTimestamp>(\d+)<\/AccessTokenTimestamp>/.exec(xml)?.[1] ?? '0');
  const lifetime = Number(/<AccessTokenExpiration>(\d+)<\/AccessTokenExpiration>/.exec(xml)?.[1] ?? '0');
  const expiresAt = issued > 0 && lifetime > 0 ? (issued + lifetime) * 1000 : Date.now() + 50 * 60 * 1000;
  setCachedToken(acc.guid, { accessToken, clientToken, expiresAt });
  console.log(`[${tag}] authenticated (token verified)`);

  return { accessToken, clientToken };
}

/**
 * Fetches the character list and the embedded server list in one call.
 *
 * @throws {AppEngineError} for account-in-use, invalid credentials, etc.
 */
export async function getCharAndServers(
  accessToken: string,
): Promise<{ char: CharInfo; servers: ServerInfo[] }> {
  const xml = await postForm(ENDPOINTS.CHAR_LIST, { do_login: 'true', accessToken, ...UNITY_FIELDS });
  const error = classifyError(xml);
  if (error) {
    throw error;
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
