import type { MediaServer, MediaServerKind, MediaServerPrefixMapping } from "./mediaServers";

// Watch sync reads the shared media server connections from Settings > Media servers.
export type WatchSyncServerKind = MediaServerKind;
export type WatchSyncPrefixMapping = MediaServerPrefixMapping;
export type WatchSyncDirection = "plex_to_jellyfin" | "jellyfin_to_plex" | "both";
export type WatchSyncTransfer = Exclude<WatchSyncDirection, "both">;
export type WatchSyncAction = "watched" | "unwatched" | "position";
export type WatchSyncUserKind = "owner" | "home" | "managed" | "friend" | "user";

export const watchSyncDirectionLabels: Record<WatchSyncDirection, string> = {
  plex_to_jellyfin: "Plex → Jellyfin",
  jellyfin_to_plex: "Jellyfin → Plex",
  both: "Both ways"
};

export interface WatchSyncSettingsInput {
  revision: number;
  paused: boolean;
  intervalMinutes: number;
  reconcileIntervalDays: number;
  syncWatched: boolean;
  syncPosition: boolean;
}

export interface WatchSyncSettings extends WatchSyncSettingsInput {
  lastReconcileAt: string | null;
}

export interface WatchSyncUser {
  serverId: string;
  externalId: string;
  name: string;
  username: string | null;
  kind: WatchSyncUserKind;
  // Plex users need their own server access token; Jellyfin users always work through the API key.
  ready: boolean;
  note: string | null;
}

export interface WatchSyncPairInput {
  plexServerId: string;
  plexUserId: string;
  jellyfinServerId: string;
  jellyfinUserId: string;
  enabled?: boolean;
  direction?: WatchSyncDirection;
  syncWatched?: boolean | null;
  syncPosition?: boolean | null;
}

export interface WatchSyncPairUpdate {
  enabled?: boolean;
  paused?: boolean;
  direction?: WatchSyncDirection;
  syncWatched?: boolean | null;
  syncPosition?: boolean | null;
}

export interface WatchSyncPreviewSample {
  direction: WatchSyncTransfer;
  action: WatchSyncAction;
  title: string;
  linkPath: string;
  positionMs: number | null;
}

export interface WatchSyncCounts {
  watched: number;
  unwatched: number;
  position: number;
}

export interface WatchSyncPreview {
  generatedAt: string;
  jobId: number | null;
  counts: Record<WatchSyncTransfer, WatchSyncCounts>;
  samples: WatchSyncPreviewSample[];
  // Items found on each side, how many of those are SRTL paths, and how many SRTL paths both servers share.
  plexItems: number;
  jellyfinItems: number;
  matched: number;
  skipped: number;
}

export interface WatchSyncPair {
  id: number;
  plexServerId: string;
  plexUserId: string;
  plexUserName: string;
  jellyfinServerId: string;
  jellyfinUserId: string;
  jellyfinUserName: string;
  enabled: boolean;
  paused: boolean;
  direction: WatchSyncDirection;
  syncWatched: boolean | null;
  syncPosition: boolean | null;
  approvedAt: string | null;
  preview: WatchSyncPreview | null;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastError: string | null;
  trackedItems: number;
}

export interface WatchSyncSuggestion {
  plexServerId: string;
  plexUserId: string;
  plexUserName: string;
  jellyfinServerId: string;
  jellyfinUserId: string;
  jellyfinUserName: string;
  match: "exact" | "similar";
}

export interface WatchSyncActivity {
  id: number;
  pairId: number | null;
  at: string;
  level: "info" | "warn" | "error";
  direction: WatchSyncTransfer | null;
  action: WatchSyncAction | null;
  linkPath: string | null;
  message: string;
  jobId: number | null;
}

export interface WatchSyncJobSummary {
  id: number;
  status: string;
  mode: WatchSyncJobMode;
}

export type WatchSyncJobMode = "preview" | "reconcile" | "restore";

export interface WatchSyncState {
  settings: WatchSyncSettings;
  // The shared media server connections, without their tokens.
  servers: MediaServer[];
  users: WatchSyncUser[];
  pairs: WatchSyncPair[];
  suggestions: WatchSyncSuggestion[];
  activeJobs: WatchSyncJobSummary[];
  indexedItems: Record<string, number>;
}

export interface WatchSyncSideState {
  watched: boolean;
  positionMs: number;
  at: string | null;
}

export interface WatchSyncBackup {
  format: "srtl-watch-sync";
  version: 1;
  exportedAt: string;
  plexUserName: string;
  jellyfinUserName: string;
  items: Array<{ linkPath: string; plex: WatchSyncSideState | null; jellyfin: WatchSyncSideState | null }>;
}

export interface WatchSyncActivityPage {
  entries: WatchSyncActivity[];
}
