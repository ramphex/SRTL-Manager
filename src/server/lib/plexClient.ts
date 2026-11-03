import { z } from "zod";
import packageJson from "../../../package.json";
import type { WatchSyncSideState } from "../../shared/watchSync";
import { WatchSyncError, normalizeServerUrl, watchSyncJson, watchSyncRequest } from "./watchSyncHttp";

// Tests point these at local mocks; nothing else changes them.
export const plexEndpoints = { plexTv: "https://plex.tv", plexApp: "https://app.plex.tv" };

const product = "SRTL Manager";

// SRTL identifies itself as its own client. It never sends X-Plex-Provides and never uses a server's own
// token, so plex.tv cannot mistake SRTL for the media server and overwrite the server's registration.
export function plexHeaders(clientIdentifier: string, token?: string): Record<string, string> {
  return {
    "X-Plex-Product": product,
    "X-Plex-Version": packageJson.version,
    "X-Plex-Client-Identifier": clientIdentifier,
    "X-Plex-Device-Name": product,
    "X-Plex-Platform": "Node.js",
    ...(token ? { "X-Plex-Token": token } : {})
  };
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[lower] ?? "";
  });
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) attributes[match[1]!] = decodeXml(match[2]!);
  return attributes;
}

// plex.tv's account APIs answer in flat XML: elements with attributes, at most one level of children.
export function xmlElements(xml: string, tag: string): Array<{ attributes: Record<string, string>; inner: string }> {
  const pattern = new RegExp(`<${tag}\\b((?:[^>"]|"[^"]*")*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g");
  return [...xml.matchAll(pattern)].map((match) => ({ attributes: xmlAttributes(match[1] ?? ""), inner: match[2] ?? "" }));
}

export interface PlexPin { id: number; code: string; expiresAt: string; authToken: string | null }
const pinSchema = z.object({ id: z.number().int().positive(), code: z.string().min(1), expiresAt: z.string().optional(), authToken: z.string().nullish() });

export interface PlexAccount { id: string; username: string; title: string; email: string | null }
export interface PlexTvUser {
  id: string;
  title: string;
  username: string | null;
  email: string | null;
  home: boolean;
  restricted: boolean;
  machineIdentifiers: string[];
}
export interface PlexSharedServer { userId: string; accessToken: string | null; username: string | null }

export class PlexTvClient {
  constructor(private readonly clientIdentifier: string) {}

  private async json(path: string, method = "GET", token?: string, signal?: AbortSignal): Promise<unknown> {
    return (await watchSyncJson({ url: `${plexEndpoints.plexTv}${path}`, service: "plex.tv", trusted: true, method, headers: plexHeaders(this.clientIdentifier, token), signal })).data;
  }

  private async xml(path: string, token: string, signal?: AbortSignal): Promise<string> {
    return (await watchSyncRequest({ url: `${plexEndpoints.plexTv}${path}`, service: "plex.tv", trusted: true, headers: { ...plexHeaders(this.clientIdentifier, token), Accept: "application/xml" }, signal })).body;
  }

  async createPin(): Promise<PlexPin> {
    const parsed = pinSchema.safeParse(await this.json("/api/v2/pins?strong=true", "POST"));
    if (!parsed.success) throw new WatchSyncError("plex.tv returned an unsupported sign-in response.");
    return { id: parsed.data.id, code: parsed.data.code, expiresAt: parsed.data.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(), authToken: parsed.data.authToken ?? null };
  }

  async checkPin(id: number): Promise<PlexPin> {
    const parsed = pinSchema.safeParse(await this.json(`/api/v2/pins/${id}`));
    if (!parsed.success) throw new WatchSyncError("plex.tv returned an unsupported sign-in response.");
    return { id: parsed.data.id, code: parsed.data.code, expiresAt: parsed.data.expiresAt ?? "", authToken: parsed.data.authToken || null };
  }

  authUrl(code: string): string {
    const query = new URLSearchParams({ clientID: this.clientIdentifier, code, "context[device][product]": product });
    return `${plexEndpoints.plexApp}/auth#?${query.toString()}`;
  }

  async account(token: string): Promise<PlexAccount> {
    const parsed = z.object({ id: z.union([z.number(), z.string()]), username: z.string().nullish(), title: z.string().nullish(), email: z.string().nullish() }).safeParse(await this.json("/api/v2/user", "GET", token));
    if (!parsed.success) throw new WatchSyncError("plex.tv returned an unsupported account response.");
    const { id, username, title, email } = parsed.data;
    return { id: String(id), username: username || title || String(id), title: title || username || String(id), email: email ?? null };
  }

  // Everyone the account shares with: Plex Home members (including managed users) and friends.
  async users(token: string, signal?: AbortSignal): Promise<PlexTvUser[]> {
    return xmlElements(await this.xml("/api/users", token, signal), "User").flatMap(({ attributes, inner }) => {
      if (!attributes.id) return [];
      return [{
        id: attributes.id,
        title: attributes.title || attributes.username || attributes.id,
        username: attributes.username || null,
        email: attributes.email || null,
        home: attributes.home === "1",
        restricted: attributes.restricted === "1",
        machineIdentifiers: xmlElements(inner, "Server").map((server) => server.attributes.machineIdentifier ?? "").filter(Boolean)
      }];
    });
  }

  // Each user's own access token for one server. Reading these never changes sharing or restrictions.
  async sharedServers(token: string, machineIdentifier: string, signal?: AbortSignal): Promise<PlexSharedServer[]> {
    return xmlElements(await this.xml(`/api/servers/${encodeURIComponent(machineIdentifier)}/shared_servers`, token, signal), "SharedServer").flatMap(({ attributes }) => attributes.userID ? [{
      userId: attributes.userID,
      accessToken: attributes.accessToken || null,
      username: attributes.username || null
    }] : []);
  }
}

export interface PlexItem {
  ratingKey: string;
  type: string;
  title: string;
  files: string[];
  state: WatchSyncSideState;
}

export interface PlexHistoryEntry { ratingKey: string; accountId: string; viewedAt: number }
export interface PlexSection { key: string; type: "movie" | "show"; title: string }

const metadataSchema = z.object({
  ratingKey: z.union([z.string(), z.number()]).transform(String),
  type: z.string().optional(),
  title: z.string().optional(),
  grandparentTitle: z.string().optional(),
  parentIndex: z.number().optional(),
  index: z.number().optional(),
  viewCount: z.number().optional(),
  viewOffset: z.number().optional(),
  lastViewedAt: z.number().optional(),
  Media: z.array(z.object({ Part: z.array(z.object({ file: z.string().optional() }).loose()).optional() }).loose()).optional()
}).loose();
type PlexMetadata = z.infer<typeof metadataSchema>;

function containerOf(data: unknown): { items: unknown[]; total: number | null; directories: unknown[] } {
  const container = (data && typeof data === "object" ? (data as { MediaContainer?: unknown }).MediaContainer : null) as Record<string, unknown> | null;
  if (!container || typeof container !== "object") throw new WatchSyncError("Plex returned an unsupported response format.");
  const total = typeof container.totalSize === "number" ? container.totalSize : null;
  return { items: Array.isArray(container.Metadata) ? container.Metadata : [], total, directories: Array.isArray(container.Directory) ? container.Directory : [] };
}

export function plexEpochToIso(value: number | undefined): string | null {
  return value && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function toItem(raw: unknown): PlexItem | null {
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item: PlexMetadata = parsed.data;
  if (item.type !== "movie" && item.type !== "episode") return null;
  const files = (item.Media ?? []).flatMap((media) => (media.Part ?? []).map((part) => part.file ?? "")).filter(Boolean);
  const episode = item.type === "episode" && item.grandparentTitle ? `${item.grandparentTitle} S${String(item.parentIndex ?? 0).padStart(2, "0")}E${String(item.index ?? 0).padStart(2, "0")} - ` : "";
  return {
    ratingKey: item.ratingKey,
    type: item.type,
    title: `${episode}${item.title ?? item.ratingKey}`,
    files,
    state: { watched: (item.viewCount ?? 0) > 0, positionMs: Math.max(0, Math.round(item.viewOffset ?? 0)), at: plexEpochToIso(item.lastViewedAt) }
  };
}

export class PlexServerClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly token: string, private readonly clientIdentifier: string, private readonly signal?: AbortSignal) {
    this.baseUrl = normalizeServerUrl(baseUrl, "Plex");
  }

  private async get(path: string, timeoutMs?: number): Promise<{ data: unknown; serverTime: Date | null }> {
    return watchSyncJson({ url: `${this.baseUrl}${path}`, service: "Plex", headers: plexHeaders(this.clientIdentifier, this.token), timeoutMs, signal: this.signal, maxBytes: 128 * 1024 * 1024 });
  }

  private async call(path: string): Promise<void> {
    await watchSyncRequest({ url: `${this.baseUrl}${path}`, service: "Plex", method: "GET", headers: plexHeaders(this.clientIdentifier, this.token), signal: this.signal });
  }

  async identity(): Promise<{ machineIdentifier: string; version: string | null }> {
    const { data } = await this.get("/identity");
    const container = (data as { MediaContainer?: { machineIdentifier?: unknown; version?: unknown } } | null)?.MediaContainer;
    if (!container || typeof container.machineIdentifier !== "string" || !container.machineIdentifier) throw new WatchSyncError("Plex did not report its machine identifier. Check the server URL.");
    return { machineIdentifier: container.machineIdentifier, version: typeof container.version === "string" ? container.version : null };
  }

  // The server's local accounts; their ids are the accountID values in its play history.
  async accounts(): Promise<Array<{ id: string; name: string }>> {
    const { data } = await this.get("/accounts");
    const accounts = (data as { MediaContainer?: { Account?: unknown } } | null)?.MediaContainer?.Account;
    return Array.isArray(accounts) ? accounts.flatMap((account) => {
      const entry = account as { id?: unknown; name?: unknown };
      return entry.id !== undefined && entry.id !== null ? [{ id: String(entry.id), name: typeof entry.name === "string" ? entry.name : "" }] : [];
    }) : [];
  }

  // Movie and TV libraries only; music, photos, and other library types are never read.
  async sections(): Promise<PlexSection[]> {
    const { directories } = containerOf((await this.get("/library/sections")).data);
    return directories.flatMap((directory) => {
      const entry = directory as { key?: unknown; type?: unknown; title?: unknown };
      return (entry.type === "movie" || entry.type === "show") && entry.key !== undefined ? [{ key: String(entry.key), type: entry.type, title: typeof entry.title === "string" ? entry.title : String(entry.key) }] : [];
    });
  }

  // One page of a library's movies (type 1) or episodes (type 4), optionally filtered, such as lastViewedAt>>=.
  async listPage(sectionKey: string, type: 1 | 4, start: number, size: number, filter = ""): Promise<{ items: PlexItem[]; total: number | null; count: number; serverTime: Date | null }> {
    const query = `type=${type}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}${filter ? `&${filter}` : ""}`;
    const { data, serverTime } = await this.get(`/library/sections/${encodeURIComponent(sectionKey)}/all?${query}`, 60_000);
    const container = containerOf(data);
    return { items: container.items.map(toItem).filter((item): item is PlexItem => Boolean(item)), total: container.total, count: container.items.length, serverTime };
  }

  async metadata(ratingKeys: string[]): Promise<PlexItem[]> {
    if (!ratingKeys.length) return [];
    const { data } = await this.get(`/library/metadata/${ratingKeys.map(encodeURIComponent).join(",")}`);
    return containerOf(data).items.map(toItem).filter((item): item is PlexItem => Boolean(item));
  }

  async onDeck(): Promise<PlexItem[]> {
    return containerOf((await this.get("/library/onDeck")).data).items.map(toItem).filter((item): item is PlexItem => Boolean(item));
  }

  // Plays of every account since a time, newest first. Needs the owner's token.
  async historyPage(sinceEpoch: number, start: number, size: number): Promise<{ entries: PlexHistoryEntry[]; count: number; serverTime: Date | null }> {
    const { data, serverTime } = await this.get(`/status/sessions/history/all?sort=viewedAt:desc&viewedAt>=${Math.max(0, Math.floor(sinceEpoch))}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`);
    const items = containerOf(data).items;
    return {
      entries: items.flatMap((raw) => {
        const entry = raw as { ratingKey?: unknown; accountID?: unknown; viewedAt?: unknown };
        return entry.ratingKey !== undefined && entry.accountID !== undefined ? [{ ratingKey: String(entry.ratingKey), accountId: String(entry.accountID), viewedAt: Number(entry.viewedAt) || 0 }] : [];
      }),
      count: items.length,
      serverTime
    };
  }

  scrobble(ratingKey: string) { return this.call(`/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`); }
  unscrobble(ratingKey: string) { return this.call(`/:/unscrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`); }
  progress(ratingKey: string, positionMs: number) {
    return this.call(`/:/progress?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}&time=${Math.max(0, Math.round(positionMs))}&state=stopped`);
  }
}
