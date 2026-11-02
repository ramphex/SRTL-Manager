import type { MediaServer, MediaServerInput, MediaServerKind, MediaServerList, MediaServerPinStatus, MediaServerPlexPin } from "../shared/mediaServers";
import { request } from "./api";

const base = "/api/media-servers";
// Watch sync, Now Playing, and invitations read the same list, so they share this query key.
export const mediaServersKey = ["media-servers"];
const send = <T,>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => request<T>(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const mediaServerApi = {
  list: () => request<MediaServerList>(base),
  add: (kind: MediaServerKind, body: MediaServerInput) => send<MediaServerList>("POST", "", { kind, ...body }),
  update: (id: string, body: MediaServerInput) => send<MediaServerList>("PUT", `/${encodeURIComponent(id)}`, body),
  remove: (id: string) => send<MediaServerList>("DELETE", `/${encodeURIComponent(id)}`),
  test: (id: string) => send<MediaServerList>("POST", `/${encodeURIComponent(id)}/test`),
  startPin: (id: string) => send<MediaServerPlexPin>("POST", `/${encodeURIComponent(id)}/plex-pin`),
  checkPin: (id: string, pinId: number) => send<MediaServerPinStatus>("POST", `/${encodeURIComponent(id)}/plex-pin/${pinId}`)
};

export function mediaServerStatus(server: MediaServer): { label: string; kind: "enabled" | "paused" | "error" | "new" } {
  if (!server.hasToken) return { label: server.kind === "plex" ? "Not signed in" : "No API key", kind: "new" };
  if (server.lastError) return { label: "Error", kind: "error" };
  if (server.lastCheckedAt) return { label: "Connected", kind: "enabled" };
  return { label: "Not checked", kind: "paused" };
}
