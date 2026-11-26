// Plex, Jellyfin, and Dupelix connections shared by watch sync and the other features that read media servers.
export const mediaServerKinds = ["plex", "jellyfin", "dupelix"] as const;
export type MediaServerKind = (typeof mediaServerKinds)[number];
// Watch sync pairs a Plex user with a Jellyfin user; other kinds are not part of it yet.
export const watchSyncServerKinds = ["plex", "jellyfin"] as const;
export type WatchSyncCapableKind = (typeof watchSyncServerKinds)[number];

export function supportsWatchSync(kind: MediaServerKind): kind is WatchSyncCapableKind {
  return (watchSyncServerKinds as readonly string[]).includes(kind);
}

export const mediaServerLimit = 10;
export const mediaServerKindLabels: Record<MediaServerKind, string> = { plex: "Plex", jellyfin: "Jellyfin", dupelix: "Dupelix" };

// The server sees the library under serverPrefix; SRTL's symlinks live under srtlPrefix.
export interface MediaServerPrefixMapping {
  serverPrefix: string;
  srtlPrefix: string;
}

export interface MediaServerInput {
  name: string;
  url: string;
  // Write-only: a Plex owner token, a Jellyfin API key, or a Dupelix API key. Empty keeps the stored one.
  token?: string;
  prefixMappings: MediaServerPrefixMapping[];
}

export interface MediaServerCreateInput extends MediaServerInput {
  kind: MediaServerKind;
}

// What the browser sees. Tokens and API keys never leave the SRTL server; hasToken says whether one is saved.
export interface MediaServer {
  id: string;
  kind: MediaServerKind;
  name: string;
  url: string;
  hasToken: boolean;
  prefixMappings: MediaServerPrefixMapping[];
  // Plex only: the server's machine identifier and the plex.tv account that owns it.
  machineIdentifier: string | null;
  accountName: string | null;
  version: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface MediaServerList {
  servers: MediaServer[];
  limit: number;
}

export interface MediaServerPlexPin {
  pinId: number;
  code: string;
  authUrl: string;
  expiresAt: string;
}

export interface MediaServerPinStatus {
  status: "waiting" | "authorized" | "expired";
  servers?: MediaServerList;
}
