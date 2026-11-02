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

// A sanity cap on stored instances, not a design limit.
export const radarrInstanceLimit = 25;

export interface RadarrSettings extends Omit<RadarrSettingsInput, "apiKey" | "webhookSecret"> {
  id: string;
  name: string;
  // The migrated first instance also answers the original webhook URL without an instance id.
  legacyWebhook: boolean;
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

export interface RadarrInstanceSummary {
  settings: RadarrSettings;
  movies: number;
  mapped: number;
  review: number;
  errors: number;
}

export interface RadarrOverview {
  instances: RadarrInstanceSummary[];
  limit: number;
}

// Each mapped Movies section of an enabled instance, with the copy monitoring default of the instance that owns it.
export interface RadarrCopySection {
  section: string;
  instanceId: string;
  instanceName: string;
  monitorOnCopy: boolean;
}

export interface RadarrCopyDefaults {
  sections: RadarrCopySection[];
}

export interface RadarrRootConflict {
  rootPath: string;
  section: string;
  instanceId: string;
  instanceName: string;
}

export interface RadarrConnectionTest {
  version: string;
  rootFolders: string[];
  automaticMappings: RadarrPathMapping[];
  unmatchedRootFolders: string[];
  // Roots that match a section already mapped by another instance.
  conflictingRootFolders: RadarrRootConflict[];
}
