import { z } from "zod";
import packageJson from "../../../package.json";
import { dupelixOptionalScopes, dupelixRequiredScopes, type MediaServerApiKey } from "../../shared/mediaServers";
import { WatchSyncError, normalizeServerUrl, watchSyncJson } from "./watchSyncHttp";

// Dupelix speaks its own API under /api/v1. SRTL authenticates with an API key (msk_...) in the Authorization
// header only; Dupelix refuses credentials in the query string. The key needs activity.read for Now Playing and
// library.read for artwork; activity.stop, activity.network and activity.guests add Stop, client addresses and
// guest profiles.
export const dupelixApiPrefix = "/api/v1";
export { dupelixOptionalScopes, dupelixRequiredScopes };

export function dupelixHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Client-Info": `SRTL-Manager/${packageJson.version} (server)` };
}

const serverInfoSchema = z.object({
  version: z.string().optional(),
  apiVersions: z.array(z.string()).optional(),
  contractRevision: z.number().int().optional()
}).loose();

const currentKeySchema = z.object({
  id: z.string().optional(),
  name: z.string().nullish(),
  prefix: z.string().nullish(),
  scopes: z.array(z.string()).optional(),
  effectiveScopes: z.array(z.string()).optional(),
  expiresAt: z.string().nullish(),
  lanOnly: z.boolean().nullish()
}).loose();

// What the key itself is allowed to do: its effective scopes, which shrink when its creator loses a permission.
export function parseDupelixKey(raw: unknown): MediaServerApiKey | null {
  const parsed = currentKeySchema.safeParse(raw);
  if (!parsed.success) return null;
  const key = parsed.data;
  const scopes = [...new Set(key.effectiveScopes ?? key.scopes ?? [])].filter((scope) => /^[a-z0-9_.]{1,64}$/.test(scope)).sort();
  const expires = key.expiresAt ? new Date(key.expiresAt) : null;
  return {
    name: key.name?.trim().slice(0, 120) || null,
    prefix: key.prefix && /^[A-Za-z0-9_-]{1,32}$/.test(key.prefix) ? key.prefix : null,
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
      ? "Dupelix rejected the API key. Create a new key in Dupelix and enter it again."
      : `Dupelix refused the API key for ${scope}. Give the key the activity.read and library.read scopes.`, error.httpStatus);
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

  async serverInfo(): Promise<DupelixServerInfo> {
    const { data } = await this.get("/server");
    const parsed = serverInfoSchema.safeParse(data);
    if (!parsed.success || parsed.data.contractRevision === undefined) throw new WatchSyncError("This address did not answer like a Dupelix server. Check the URL.");
    return { version: parsed.data.version?.trim() || null, contractRevision: parsed.data.contractRevision };
  }

  // The key describes itself on newer servers. Null when the server is too old to have this endpoint.
  async currentKey(): Promise<MediaServerApiKey | null> {
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

  // Proves the key works and holds the scopes SRTL needs, so a wrong key or a missing scope fails the connection test
  // instead of the first Now Playing poll. Newer servers describe the key; older ones are probed with one page of
  // sessions (activity.read) and one title list entry (library.read).
  async checkAccess(): Promise<MediaServerApiKey | null> {
    const key = await this.currentKey();
    if (key) {
      const missing = dupelixRequiredScopes.filter((scope) => !key.scopes.includes(scope));
      if (missing.length) throw new WatchSyncError(`The Dupelix API key is missing the ${missing.join(" and ")} scope${missing.length === 1 ? "" : "s"}. Give the key the activity.read and library.read scopes.`, 403);
      return key;
    }
    await this.get("/activity/sessions?limit=1").catch((error: unknown) => scopeMessage(error, "activity.read (Now Playing)"));
    await this.get("/titles?limit=1").catch((error: unknown) => scopeMessage(error, "library.read (artwork)"));
    return null;
  }
}
