import type { JobStatus, StoragePolicyKind } from "./types";

export interface RadarrPathMapping {
  rootPath: string;
  section: string;
}

export interface RadarrSettingsInput {
  revision: number;
  baseUrl: string;
  apiKey?: string;
  webhookSecret?: string;
  enabled: boolean;
  localTag: string;
  remoteTag: string;
  monitorOnCopy: boolean;
  mappingMode: "auto" | "manual";
  mappings: RadarrPathMapping[];
}

export interface RadarrSettings extends Omit<RadarrSettingsInput, "apiKey" | "webhookSecret"> {
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export interface RadarrMovieStatus {
  movieId: number;
  tmdbId: number;
  title: string;
  folderPath: string;
  section: string | null;
  itemName: string | null;
  tags: string[];
  monitored: boolean | null;
  policy: StoragePolicyKind;
  tagPolicy: StoragePolicyKind | "conflict";
  managed: boolean;
  status: "unmapped" | "review" | "pending" | "synced" | "error";
  message: string | null;
  syncedAt: string | null;
}

export interface RadarrEventStatus {
  id: number;
  movieId: number;
  title: string;
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  error: string | null;
  jobId: number | null;
  jobStatus: JobStatus | null;
}

export interface RadarrMonitorUpdateStatus {
  id: number;
  movieId: number;
  title: string;
  monitored: boolean;
  copyJobId: number | null;
  createdAt: string;
  processedAt: string | null;
  error: string | null;
}

export interface RadarrState {
  settings: RadarrSettings;
  movies: RadarrMovieStatus[];
  events: RadarrEventStatus[];
  monitorUpdates: RadarrMonitorUpdateStatus[];
}

export interface RadarrCopyDefaults {
  available: boolean;
  monitorOnCopy: boolean;
  sections: string[];
}

export interface RadarrConnectionTest {
  version: string;
  rootFolders: string[];
  automaticMappings: RadarrPathMapping[];
  unmatchedRootFolders: string[];
}
