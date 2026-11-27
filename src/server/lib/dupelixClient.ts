import { z } from "zod";
import packageJson from "../../../package.json";
import { dupelixOptionalScopes, dupelixPermission, dupelixPermissionNames, dupelixRequiredScopes } from "../../shared/mediaServers";
import { WatchSyncError, normalizeServerUrl, watchSyncJson } from "./watchSyncHttp";

// Dupelix speaks its own API under /api/v1. SRTL authenticates with an API key (msk_...) in the Authorization
// header only; Dupelix refuses credentials in the query string. The key needs activity.read for Now Playing;
// activity.stop, activity.network and activity.guests add Stop, client addresses and guest profiles, and
// library.read lets SRTL look up a title's artwork when a stream carries none. Dupelix's key form (Admin >
// Integrations) names these as permissions, which is what SRTL's messages show. A key another machine sent over plain
// HTTP becomes LAN only and is refused on Dupelix's HTTPS address; keys used on Dupelix's own address or its
// integration network are not marked. On Dupelix's local integration routes every request needs the
// key, /server included: without one the route answers 404, and an invalid or revoked key gets 401. So SRTL sends
// the key on every request, in exactly one Authorization header, and never sends forwarding headers.
export const dupelixApiPrefix = "/api/v1";
export { dupelixOptionalScopes, dupelixRequiredScopes };

export const dupelixWrongAddress = "This address is not a Dupelix integration route (HTTP 404). Check the URL: use the address and port Dupelix gives integrations, without /api/v1.";
export const dupelixKeyExpired = "The Dupelix key has expired. Create a new one in Dupelix under Admin > Integrations.";
export const dupelixKeyLanOnly = "The Dupelix key is LAN only because another machine sent it over plain HTTP, so Dupelix refuses it on this HTTPS address. Use Dupelix's local integration address, or a separate key for this address.";
export const dupelixKeyRejected = "Dupelix rejected the API key (HTTP 401): it is invalid or has been revoked. Create a new key in Dupelix under Admin > Integrations and enter it again.";
const needsRead = `Give the key the Dupelix permission ${dupelixPermission("activity.read")} under Admin > Integrations.`;

export function dupelixHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Client-Info": `SRTL-Manager/${packageJson.version} (server)` };
}

const serverInfoSchema = z.object({
  version: z.string().optional(),
  apiVersions: z.array(z.string()).optional(),
  contractRevision: z.number().int().optional()
}).loose();

const currentKeySchema = z.object({
  scopes: z.array(z.string()).optional(),
  effectiveScopes: z.array(z.string()).optional(),
  expiresAt: z.string().nullish(),
  lanOnly: z.boolean().nullish()
}).loose();

// What SRTL reads from Dupelix's description of its own key. The key's name and visible start are never kept: SRTL
// only needs to know what the key may do, when it expires, and whether Dupelix limits it to the LAN.
export interface DupelixKeyInfo {
  // Effective scopes: what the key may do now, as far as its creator still holds those permissions.
  scopes: string[];
  // Null when the key never expires.
  expiresAt: string | null;
  // True once another machine sent the key over plain HTTP: Dupelix then refuses it on its HTTPS address.
  lanOnly: boolean | null;
}

export function parseDupelixKey(raw: unknown): DupelixKeyInfo | null {
  const parsed = currentKeySchema.safeParse(raw);
  if (!parsed.success) return null;
  const key = parsed.data;
  const scopes = [...new Set(key.effectiveScopes ?? key.scopes ?? [])].filter((scope) => /^[a-z0-9_.]{1,64}$/.test(scope)).sort();
  const expires = key.expiresAt ? new Date(key.expiresAt) : null;
  return {
    scopes,
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : null,
    lanOnly: key.lanOnly ?? null
  };
}

export interface DupelixServerInfo {
  version: string | null;
  contractRevision: number | null;
}

// "0.1.0 b1 (API revision 145)": Dupelix reports its product version only to an authenticated caller, so the API
// revision alone is shown when the version is missing.
export function dupelixVersionLabel(info: DupelixServerInfo): string | null {
  const revision = info.contractRevision !== null ? `API revision ${info.contractRevision}` : null;
  if (info.version && revision) return `${info.version} (${revision})`;
  return info.version ?? revision;
}

function scopeMessage(error: unknown, scope: string): never {
  if (error instanceof WatchSyncError && (error.httpStatus === 401 || error.httpStatus === 403)) {
    throw new WatchSyncError(error.httpStatus === 401
      ? dupelixKeyRejected
      : `Dupelix refused the API key for ${scope}. ${needsRead} A LAN-only key also fails on Dupelix's HTTPS address.`, error.httpStatus);
  }
  throw error;
}

export class DupelixClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly apiKey: string, private readonly signal?: AbortSignal) {
    this.baseUrl = normalizeServerUrl(baseUrl, "Dupelix");
  }

  private get(path: string) {
    return watchSyncJson({ url: `${this.baseUrl}${dupelixApiPrefix}${path}`, service: "Dupelix", headers: dupelixHeaders(this.apiKey), timeoutMs: 8000, retries: 1, signal: this.signal, maxBytes: 4 * 1024 * 1024 });
  }

  // Sent with the key: local integration routes hide even /server from callers without one.
  async serverInfo(): Promise<DupelixServerInfo> {
    let data: unknown;
    try {
      ({ data } = await this.get("/server"));
    } catch (error) {
      if (error instanceof WatchSyncError && error.httpStatus === 404) throw new WatchSyncError(dupelixWrongAddress, 404);
      if (error instanceof WatchSyncError && error.httpStatus === 401) throw new WatchSyncError(dupelixKeyRejected, 401);
      throw error;
    }
    const parsed = serverInfoSchema.safeParse(data);
    if (!parsed.success || parsed.data.contractRevision === undefined) throw new WatchSyncError("This address did not answer like a Dupelix server. Check the URL.");
    return { version: parsed.data.version?.trim() || null, contractRevision: parsed.data.contractRevision };
  }

  // The key describes itself on newer servers. Null when the server is too old to have this endpoint.
  async currentKey(): Promise<DupelixKeyInfo | null> {
    try {
      const { data } = await this.get("/api-keys/current");
      const key = parseDupelixKey(data);
      if (!key) throw new WatchSyncError("Dupelix returned an unsupported API key description.");
      return key;
    } catch (error) {
      if (error instanceof WatchSyncError && error.httpStatus === 404) return null;
      if (error instanceof WatchSyncError && error.httpStatus === 401) scopeMessage(error, "this server");
      throw error;
    }
  }

  // Proves the key works for Now Playing, so a problem with it fails the connection test (and shows as the server's
  // status) instead of the first Now Playing poll: an expired key, a missing required permission, or a LAN-only key on
  // an HTTPS address. Missing optional permissions only hide their features. Newer servers describe the key; older
  // ones are probed with one session.
  async checkAccess(now = Date.now()): Promise<void> {
    const key = await this.currentKey();
    if (key) {
      if (key.expiresAt && Date.parse(key.expiresAt) <= now) throw new WatchSyncError(dupelixKeyExpired, 403);
      const missing = dupelixRequiredScopes.filter((scope) => !key.scopes.includes(scope));
      if (missing.length) throw new WatchSyncError(`The Dupelix key is missing the permission${missing.length === 1 ? "" : "s"} ${missing.map((scope) => dupelixPermissionNames[scope] ?? scope).join(" and ")}. Edit the key in Dupelix under Admin > Integrations.`, 403);
      if (key.lanOnly === true && /^https:/i.test(this.baseUrl)) throw new WatchSyncError(dupelixKeyLanOnly, 403);
      return;
    }
    await this.get("/activity/sessions?limit=1").catch((error: unknown) => scopeMessage(error, "Now Playing"));
  }
}
