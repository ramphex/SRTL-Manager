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

export const plexPinPollMs = 3000;

// Checks a Plex sign-in until it is approved or ends. Each check waits for the previous answer, so a slow sign-in
// (saving the token and testing the server can take a while) is never asked about twice at once. Returns a stop function.
export function pollPlexPin(check: () => Promise<MediaServerPinStatus>, onUpdate: (update: { status: MediaServerPinStatus } | { error: unknown }) => void, delayMs = plexPinPollMs): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { timer = setTimeout(run, delayMs); };
  const run = () => {
    check().then((status) => {
      if (stopped) return;
      onUpdate({ status });
      if (status.status === "waiting") schedule();
      else stopped = true;
    }, (error: unknown) => {
      if (stopped) return;
      stopped = true;
      onUpdate({ error });
    });
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}

// Opens the plex.tv window while the click still counts as the user's, so browsers do not block it, and points it at the
// sign-in page once SRTL has a PIN. The window cannot reach back into SRTL.
export interface PlexWindow { show: (url: string) => void; close: () => void }
export function openPlexWindow(): PlexWindow {
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
  } catch {
    popup = null;
  }
  return {
    show: (url) => {
      if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, "_blank", "noopener");
    },
    close: () => { if (popup && !popup.closed) popup.close(); }
  };
}
