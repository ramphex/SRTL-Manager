import { z } from "zod";
import packageJson from "../../../package.json";
import type { WatchSyncSideState } from "../../shared/watchSync";
import { WatchSyncError, normalizeServerUrl, watchSyncJson, watchSyncRequest } from "./watchSyncHttp";

const ticksPerMs = 10_000;

export interface JellyfinUser { id: string; name: string; disabled: boolean }
export interface JellyfinItem { id: string; type: string; title: string; path: string | null; state: WatchSyncSideState }

const userSchema = z.object({ Id: z.string().min(1), Name: z.string(), Policy: z.object({ IsDisabled: z.boolean().optional() }).loose().optional() }).loose();
const itemSchema = z.object({
  Id: z.string().min(1),
  Type: z.string().optional(),
  Name: z.string().nullish(),
  SeriesName: z.string().nullish(),
  ParentIndexNumber: z.number().nullish(),
  IndexNumber: z.number().nullish(),
  Path: z.string().nullish(),
  UserData: z.object({ Played: z.boolean().optional(), PlaybackPositionTicks: z.number().optional(), LastPlayedDate: z.string().nullish() }).loose().nullish()
}).loose();

function toItem(raw: unknown): JellyfinItem | null {
  const parsed = itemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (item.Type !== "Movie" && item.Type !== "Episode") return null;
  const episode = item.Type === "Episode" && item.SeriesName ? `${item.SeriesName} S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber ?? 0).padStart(2, "0")} - ` : "";
  const lastPlayed = item.UserData?.LastPlayedDate ? new Date(item.UserData.LastPlayedDate) : null;
  return {
    id: item.Id,
    type: item.Type,
    title: `${episode}${item.Name ?? item.Id}`,
    path: item.Path ?? null,
    state: {
      watched: item.UserData?.Played === true,
      positionMs: Math.max(0, Math.round((item.UserData?.PlaybackPositionTicks ?? 0) / ticksPerMs)),
      at: lastPlayed && Number.isFinite(lastPlayed.getTime()) ? lastPlayed.toISOString() : null
    }
  };
}

const itemFields = "Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Path&EnableImages=false&EnableUserData=true";

export class JellyfinClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly apiKey: string, private readonly deviceId: string, private readonly signal?: AbortSignal) {
    this.baseUrl = normalizeServerUrl(baseUrl, "Jellyfin");
  }

  private headers(): Record<string, string> {
    return { Authorization: `MediaBrowser Client="SRTL Manager", Device="SRTL Manager", DeviceId="${this.deviceId}", Version="${packageJson.version}", Token="${this.apiKey}"` };
  }

  private async get(path: string, timeoutMs?: number) {
    return watchSyncJson({ url: `${this.baseUrl}${path}`, service: "Jellyfin", headers: this.headers(), timeoutMs, signal: this.signal, maxBytes: 128 * 1024 * 1024 });
  }

  // Newer Jellyfin moved per-user routes; older servers only answer the legacy /Users/{id}/... form.
  private async write(method: "POST" | "DELETE", path: string, legacyPath: string, body?: unknown): Promise<void> {
    const request = { service: "Jellyfin", method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal };
    try {
      await watchSyncRequest({ ...request, url: `${this.baseUrl}${path}` });
    } catch (error) {
      if (!(error instanceof WatchSyncError) || (error.httpStatus !== 404 && error.httpStatus !== 405)) throw error;
      await watchSyncRequest({ ...request, url: `${this.baseUrl}${legacyPath}` });
    }
  }

  async systemInfo(): Promise<{ serverName: string; version: string | null }> {
    const parsed = z.object({ ServerName: z.string().optional(), Version: z.string().optional() }).loose().safeParse((await this.get("/System/Info")).data);
    if (!parsed.success) throw new WatchSyncError("Jellyfin returned an unsupported response format.");
    return { serverName: parsed.data.ServerName ?? "Jellyfin", version: parsed.data.Version ?? null };
  }

  async users(): Promise<JellyfinUser[]> {
    const parsed = z.array(userSchema).max(10000).safeParse((await this.get("/Users")).data);
    if (!parsed.success) throw new WatchSyncError("Jellyfin returned an unsupported user list.");
    return parsed.data.map((user) => ({ id: user.Id, name: user.Name, disabled: user.Policy?.IsDisabled === true }));
  }

  // One page of a user's movies and episodes with their watch state. minDateLastSavedForUser limits it to
  // items whose watch state changed since then; minDateLastSaved to items added or changed since then.
  async itemsPage(userId: string, start: number, limit: number, filter: { minDateLastSavedForUser?: string; minDateLastSaved?: string; ids?: string[] } = {}): Promise<{ items: JellyfinItem[]; total: number | null; count: number; serverTime: Date | null }> {
    const parts = [`userId=${encodeURIComponent(userId)}`, itemFields, `StartIndex=${start}`, `Limit=${limit}`, "EnableTotalRecordCount=true", "SortBy=SortName", "SortOrder=Ascending"];
    if (filter.minDateLastSavedForUser) parts.push(`MinDateLastSavedForUser=${encodeURIComponent(filter.minDateLastSavedForUser)}`);
    if (filter.minDateLastSaved) parts.push(`MinDateLastSaved=${encodeURIComponent(filter.minDateLastSaved)}`);
    if (filter.ids?.length) parts.push(`Ids=${filter.ids.map(encodeURIComponent).join(",")}`);
    const { data, serverTime } = await this.get(`/Items?${parts.join("&")}`, 60_000);
    const parsed = z.object({ Items: z.array(z.unknown()), TotalRecordCount: z.number().optional() }).loose().safeParse(data);
    if (!parsed.success) throw new WatchSyncError("Jellyfin returned an unsupported item list.");
    return { items: parsed.data.Items.map(toItem).filter((item): item is JellyfinItem => Boolean(item)), total: parsed.data.TotalRecordCount ?? null, count: parsed.data.Items.length, serverTime };
  }

  markPlayed(userId: string, itemId: string, datePlayed: string | null) {
    const date = datePlayed ? `datePlayed=${encodeURIComponent(datePlayed)}` : "";
    return this.write("POST", `/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(userId)}${date ? `&${date}` : ""}`, `/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(itemId)}${date ? `?${date}` : ""}`);
  }

  markUnplayed(userId: string, itemId: string) {
    return this.write("DELETE", `/UserPlayedItems/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(userId)}`, `/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(itemId)}`);
  }

  setPosition(userId: string, itemId: string, positionMs: number, lastPlayed: string | null) {
    const body = { PlaybackPositionTicks: Math.max(0, Math.round(positionMs)) * ticksPerMs, Played: false, ...(lastPlayed ? { LastPlayedDate: lastPlayed } : {}) };
    return this.write("POST", `/UserItems/${encodeURIComponent(itemId)}/UserData?userId=${encodeURIComponent(userId)}`, `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}/UserData`, body);
  }
}
