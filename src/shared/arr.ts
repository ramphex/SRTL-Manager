// Settings and status shapes shared by the Radarr and Sonarr integrations.
import type { JobStatus, StoragePolicyKind } from "./types";

export interface ArrPathMapping {
  rootPath: string;
  section: string;
}

export interface ArrSettingsInput {
  revision: number;
  baseUrl: string;
  apiKey?: string;
  webhookSecret?: string;
  enabled: boolean;
  localTag: string;
  remoteTag: string;
  monitorOnCopy: boolean;
  mappingMode: "auto" | "manual";
  mappings: ArrPathMapping[];
}

// 32 random bytes as unpadded URL-safe base64: 43 characters that satisfy the webhook secret rules.
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// A sanity cap on stored instances per integration, not a design limit.
export const arrInstanceLimit = 25;

export interface ArrSettings extends Omit<ArrSettingsInput, "apiKey" | "webhookSecret"> {
  id: string;
  name: string;
  // The migrated first Radarr instance also answers the original webhook URL without an instance id.
  legacyWebhook: boolean;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export type ArrSyncStatus = "unmapped" | "review" | "pending" | "synced" | "error";

// One Radarr movie or Sonarr series in the policy preview.
export interface ArrTitleStatus {
  title: string;
  folderPath: string;
  section: string | null;
  itemName: string | null;
  tags: string[];
  monitored: boolean | null;
  policy: StoragePolicyKind;
  tagPolicy: StoragePolicyKind | "conflict";
  managed: boolean;
  status: ArrSyncStatus;
  message: string | null;
  syncedAt: string | null;
}

export interface ArrEventStatus {
  id: number;
  title: string;
  eventType: string;
  receivedAt: string;
  processedAt: string | null;
  error: string | null;
  jobId: number | null;
  jobStatus: JobStatus | null;
}

export interface ArrMonitorUpdateStatus {
  id: number;
  title: string;
  monitored: boolean;
  copyJobId: number | null;
  createdAt: string;
  processedAt: string | null;
  error: string | null;
}

// Each mapped section of an enabled instance, with the copy monitoring default of the instance that owns it.
export interface ArrCopySection {
  section: string;
  instanceId: string;
  instanceName: string;
  monitorOnCopy: boolean;
}

export interface ArrCopyDefaults {
  sections: ArrCopySection[];
}

export interface ArrRootConflict {
  rootPath: string;
  section: string;
  instanceId: string;
  instanceName: string;
}

export interface ArrConnectionTest {
  version: string;
  rootFolders: string[];
  automaticMappings: ArrPathMapping[];
  unmatchedRootFolders: string[];
  // Roots that match a section already mapped by another instance.
  conflictingRootFolders: ArrRootConflict[];
}
