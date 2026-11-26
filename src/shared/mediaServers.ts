// Plex, Jellyfin, and Dupelix connections shared by watch sync and the other features that read media servers.
export const mediaServerKinds = ["plex", "jellyfin", "dupelix"] as const;
export type MediaServerKind = (typeof mediaServerKinds)[number];
// Watch sync pairs a Plex user with a Jellyfin user; other kinds are not part of it yet.
export const watchSyncServerKinds = ["plex", "jellyfin"] as const;
export type WatchSyncCapableKind = (typeof watchSyncServerKinds)[number];

export function supportsWatchSync(kind: MediaServerKind): kind is WatchSyncCapableKind {
  return (watchSyncServerKinds as readonly string[]).includes(kind);
}

// Dupelix API key scopes: the ones Now Playing needs, and the ones that add features when the key has them.
// Streams carry their own artwork, so library.read only lets SRTL look a title's artwork up when a stream has none.
export const dupelixRequiredScopes = ["activity.read"] as const;
export const dupelixOptionalScopes = [
  { scope: "activity.stop", purpose: "the Stop button" },
  { scope: "activity.network", purpose: "client addresses, location, and LAN or WAN" },
  { scope: "activity.guests", purpose: "guest profiles' streams, and stopping them" },
  { scope: "library.read", purpose: "artwork for streams that carry none" }
] as const;

// Dupelix's key form (Admin > Integrations) shows each scope as a named permission; SRTL leads with that name and
// keeps the id beside it for support.
export const dupelixPermissionNames: Readonly<Record<string, string>> = {
  "activity.read": "See who is watching",
  "activity.stop": "Stop playback streams",
  "activity.network": "See playback client IP addresses",
  "activity.guests": "Let API keys created by this role include guests' streams",
  "library.read": "Browse the library"
};

// Plain text for server messages: the permission "See who is watching" (activity.read). Unknown ids stay as they are.
export function dupelixPermission(scope: string): string {
  const name = dupelixPermissionNames[scope];
  return name ? `"${name}" (${scope})` : scope;
}

// What a Dupelix server reports about the key SRTL uses, from the last connection test.
export interface MediaServerApiKey {
  name: string | null;
  // The key's visible start, such as "msk_ab12cd34"; never the whole key.
  prefix: string | null;
  // Effective scopes: what the key may do now, as far as its creator still holds those permissions.
  scopes: string[];
  // Null when the key never expires.
  expiresAt: string | null;
  lanOnly: boolean | null;
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
  // Dupelix only: the API key's name, scopes, and expiry, when the server describes its keys. Absent otherwise.
  apiKey?: MediaServerApiKey | null;
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
