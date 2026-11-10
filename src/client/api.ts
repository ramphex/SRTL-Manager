import type { ReRequestList, ReRequestPreview } from "../shared/reRequests";
import type {
  AuditOptions,
  AuditResultPage,
  AuditRunRecord,
  AuditSettings,
  AdvancedSettings,
  AppVersionInfo,
  CopyConflictPreview,
  DamagedFileRow,
  CopyFailureList,
  CopyRetryPlan,
  CopyRetryStarted,
  CopyReconciliationState,
  InventorySummary,
  InventoryScanTimestamps,
  JobEventPage,
  JobEventRecord,
  JobRecord,
  LinkKind,
  MediaLinkRow,
  MediaLinksPage,
  MediaLinkTree,
  MediaLinkTreeKindFilter,
  OnboardingStartRequest,
  OnboardingState,
  CopyOptions,
  PartialCopyDiscardPreview,
  PartialCopyDiscardRequest,
  PartialCopyDiscardQueued,
  PathsSettings,
  PathConfigurationState,
  ScanRunRecord,
  ScanOptions,
  ScanStartResult,
  SectionSettings,
  SectionSummary,
  DefaultPolicyApplyResult,
  DefaultPolicyPreview,
  StoragePolicyKind,
  StoragePolicyBulkResult,
  StoragePolicyTitle,
  StorageFileRow,
  StorageFileTree,
  StorageLocationNamesUpdate,
  StorageLocationsSettings,
  StorageRootType,
  UserPreferences,
  HeldOrphanFile,
  OrphanPurgeItemOutcome,
  OrphanPurgeItemPage,
  OrphanPurgeMode,
  OrphanReview
} from "../shared/types";

import type { AccountList, AuthMe, AuthSessionList, SecurityEventPage } from "../shared/auth";
import type { AccountRecord, AccountRole } from "../shared/permissions";
import type { BackupSettings, BackupState } from "../shared/backups";
import type { RadarrConnectionTest, RadarrCopyDefaults, RadarrOverview, RadarrSettingsInput, RadarrState } from "../shared/radarr";
import type { SonarrConnectionTest, SonarrCopyDefaults, SonarrOverview, SonarrSettingsInput, SonarrState } from "../shared/sonarr";

type ApiErrorPayload = {
  error?: string;
  requestId?: string;
  issues?: Array<{ message?: string }>;
};

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...init
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;
    const message = payload.error ?? payload.issues?.[0]?.message ?? `${response.status} ${response.statusText}`;
    // Server errors carry a reference the user can quote; the details are in the server log under the same ID.
    throw new Error(payload.requestId && response.status >= 500 ? `${message} Reference: ${payload.requestId}.` : message);
  }
  return (await response.json()) as T;
}

const mediaLinkLookupBatchSize = 1000;

export async function mediaLinksByIds(ids: number[]): Promise<MediaLinkRow[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  const rows: MediaLinkRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += mediaLinkLookupBatchSize) {
    const batch = uniqueIds.slice(offset, offset + mediaLinkLookupBatchSize);
    rows.push(...(await request<MediaLinkRow[]>("/api/media-links/by-ids", { method: "POST", body: JSON.stringify({ ids: batch }) })));
  }
  return rows;
}

export const api = {
  me: () => request<AuthMe>("/api/auth/me"),
  setup: (body: { setupToken: string; username: string; password: string; confirmPassword: string }) =>
    request<{ ok: true }>("/api/auth/setup", { method: "POST", body: JSON.stringify(body) }),
  login: (body: { username: string; password: string }) => request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  updateUser: (body: { username: string; currentPassword: string; newPassword?: string; confirmNewPassword?: string }) =>
    request<{ user: NonNullable<AuthMe["user"]> }>("/api/auth/user", { method: "PUT", body: JSON.stringify(body) }),
  accounts: () => request<AccountList>("/api/accounts"),
  createAccount: (body: { username: string; role: AccountRole; temporaryPassword: string }) => request<AccountRecord>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  changeAccountRole: (id: number, role: AccountRole) => request<{ ok: true }>(`/api/accounts/${id}/role`, { method: "PUT", body: JSON.stringify({ role }) }),
  disableAccount: (id: number) => request<{ ok: true }>(`/api/accounts/${id}/disable`, { method: "POST" }),
  enableAccount: (id: number) => request<{ ok: true }>(`/api/accounts/${id}/enable`, { method: "POST" }),
  deleteAccount: (id: number) => request<{ ok: true }>(`/api/accounts/${id}`, { method: "DELETE" }),
  resetAccountPassword: (id: number, temporaryPassword: string) => request<{ ok: true }>(`/api/accounts/${id}/reset-password`, { method: "POST", body: JSON.stringify({ temporaryPassword }) }),
  transferOwnership: (targetId: number, currentPassword: string) => request<{ ok: true }>("/api/accounts/transfer-ownership", { method: "POST", body: JSON.stringify({ targetId, currentPassword }) }),
  sessions: () => request<AuthSessionList>("/api/auth/sessions"),
  revokeSession: (id: number) => request<{ ok: true; current: boolean }>(`/api/auth/sessions/${encodeURIComponent(String(id))}`, { method: "DELETE" }),
  revokeOtherSessions: () => request<{ ok: true; revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" }),
  securityEvents: (before?: number) => request<SecurityEventPage>(`/api/auth/security-events?limit=50${before ? `&before=${before}` : ""}`),
  backups: () => request<BackupState>("/api/backups"),
  saveBackupSettings: (body: BackupSettings) => request<BackupState>("/api/backups/settings", { method: "PUT", body: JSON.stringify(body) }),
  runBackup: () => request<{ jobId: number }>("/api/backups/run", { method: "POST" }),
  appVersion: (refresh = false) => request<AppVersionInfo>(`/api/system/version${refresh ? "?refresh=true" : ""}`),
  getPaths: () => request<PathsSettings>("/api/settings/paths"),
  getStorageLocations: () => request<StorageLocationsSettings>("/api/settings/storage-locations"),
  saveStorageLocations: (body: StorageLocationNamesUpdate) =>
    request<StorageLocationsSettings>("/api/settings/storage-locations", { method: "PUT", body: JSON.stringify(body) }),
  pathConfiguration: () => request<PathConfigurationState>("/api/system/path-migration"),
  onboarding: () => request<OnboardingState>("/api/onboarding"),
  startOnboarding: (body: OnboardingStartRequest) =>
    request<{ jobId: number; state: OnboardingState }>("/api/onboarding/start", { method: "POST", body: JSON.stringify(body) }),
  planPathMigration: (migrationId: number) =>
    request<PathConfigurationState>("/api/system/path-migration/plan", { method: "POST", body: JSON.stringify({ migrationId }) }),
  applyPathMigration: (migrationId: number) =>
    request<{ jobId: number }>("/api/system/path-migration/apply", { method: "POST", body: JSON.stringify({ migrationId, confirmSameStorage: true }) }),
  getSections: () => request<SectionSettings>("/api/settings/sections"),
  saveSections: (body: SectionSettings) => request<SectionSettings>("/api/settings/sections", { method: "PUT", body: JSON.stringify(body) }),
  getScanSettings: () => request<ScanOptions>("/api/settings/scan"),
  saveScanSettings: (body: ScanOptions) => request<ScanOptions>("/api/settings/scan", { method: "PUT", body: JSON.stringify(body) }),
  getAuditSettings: () => request<AuditSettings>("/api/settings/audit"),
  saveAuditSettings: (body: AuditSettings) => request<AuditSettings>("/api/settings/audit", { method: "PUT", body: JSON.stringify(body) }),
  getAdvancedSettings: () => request<AdvancedSettings>("/api/settings/advanced"),
  getRadarrOverview: () => request<RadarrOverview>("/api/settings/radarr"),
  getRadarr: (instanceId: string) => request<RadarrState>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}`),
  getRadarrCopyDefaults: () => request<RadarrCopyDefaults>("/api/settings/radarr/copy-defaults"),
  createRadarrInstance: (name: string) => request<RadarrState>("/api/settings/radarr/instances", { method: "POST", body: JSON.stringify({ name }) }),
  renameRadarrInstance: (instanceId: string, name: string) => request<RadarrOverview>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}/rename`, { method: "POST", body: JSON.stringify({ name }) }),
  removeRadarrInstance: (instanceId: string) => request<RadarrOverview>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" }),
  saveRadarr: (instanceId: string, body: RadarrSettingsInput) => request<RadarrState>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}`, { method: "PUT", body: JSON.stringify(body) }),
  testRadarr: (instanceId: string, body: RadarrSettingsInput) => request<RadarrConnectionTest>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}/test`, { method: "POST", body: JSON.stringify(body) }),
  refreshRadarr: (instanceId: string) => request<RadarrState>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}/refresh`, { method: "POST" }),
  reconcileRadarr: (instanceId: string, movieIds: number[], action: "use_srtl" | "import_tags") => request<RadarrState>(`/api/settings/radarr/instances/${encodeURIComponent(instanceId)}/reconcile`, { method: "POST", body: JSON.stringify({ movieIds, action }) }),
  getSonarrOverview: () => request<SonarrOverview>("/api/settings/sonarr"),
  getSonarr: (instanceId: string) => request<SonarrState>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}`),
  getSonarrCopyDefaults: () => request<SonarrCopyDefaults>("/api/settings/sonarr/copy-defaults"),
  createSonarrInstance: (name: string) => request<SonarrState>("/api/settings/sonarr/instances", { method: "POST", body: JSON.stringify({ name }) }),
  renameSonarrInstance: (instanceId: string, name: string) => request<SonarrOverview>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}/rename`, { method: "POST", body: JSON.stringify({ name }) }),
  removeSonarrInstance: (instanceId: string) => request<SonarrOverview>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" }),
  saveSonarr: (instanceId: string, body: SonarrSettingsInput) => request<SonarrState>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}`, { method: "PUT", body: JSON.stringify(body) }),
  testSonarr: (instanceId: string, body: SonarrSettingsInput) => request<SonarrConnectionTest>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}/test`, { method: "POST", body: JSON.stringify(body) }),
  refreshSonarr: (instanceId: string) => request<SonarrState>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}/refresh`, { method: "POST" }),
  reconcileSonarr: (instanceId: string, seriesIds: number[], action: "use_srtl" | "import_tags") => request<SonarrState>(`/api/settings/sonarr/instances/${encodeURIComponent(instanceId)}/reconcile`, { method: "POST", body: JSON.stringify({ seriesIds, action }) }),
  saveAdvancedSettings: (body: AdvancedSettings) => request<AdvancedSettings>("/api/settings/advanced", { method: "PUT", body: JSON.stringify(body) }),
  getUserPreferences: () => request<UserPreferences>("/api/settings/user-preferences"),
  saveUserPreferences: (body: UserPreferences) => request<UserPreferences>("/api/settings/user-preferences", { method: "PUT", body: JSON.stringify(body) }),
  startScan: (body?: ScanOptions) => request<ScanStartResult>("/api/scans", { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  scans: () => request<ScanRunRecord[]>("/api/scans"),
  sections: () => request<SectionSummary[]>("/api/sections"),
  inventorySummary: () => request<InventorySummary>("/api/inventory/summary"),
  inventoryScanTimestamps: () => request<InventoryScanTimestamps>("/api/inventory/scan-timestamps"),
  startCopy: (body: CopyOptions) => request<{ jobId: number }>("/api/copies", { method: "POST", body: JSON.stringify(body) }),
  copyConflicts: (body: CopyOptions) => request<CopyConflictPreview>("/api/copies/conflicts", { method: "POST", body: JSON.stringify(body) }),
  copyReconciliation: () => request<CopyReconciliationState>("/api/job-reconciliation"),
  recheckCopyReconciliation: () => request<CopyReconciliationState>("/api/job-reconciliation/recheck", { method: "POST" }),
  previewPartialCopyDiscard: (operationId: number) => request<PartialCopyDiscardPreview>(`/api/job-reconciliation/${operationId}/discard-partial-copy`),
  discardPartialCopy: (operationId: number, body: PartialCopyDiscardRequest) =>
    request<PartialCopyDiscardQueued>(`/api/job-reconciliation/${operationId}/discard-partial-copy`, { method: "POST", body: JSON.stringify(body) }),
  mediaLinks: (kind?: string) => request<MediaLinkRow[]>(`/api/media-links${kind ? `?kind=${kind}` : ""}`),
  mediaLinksByIds,
  mediaLinksPage: (params: { kind?: LinkKind; section?: string; storagePolicy?: StoragePolicyKind; relativePathPrefix?: string; search?: string; limit: number; offset: number }) => {
    const search = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.kind) search.set("kind", params.kind);
    if (params.section) search.set("section", params.section);
    if (params.storagePolicy) search.set("storagePolicy", params.storagePolicy);
    if (params.relativePathPrefix) search.set("relativePathPrefix", params.relativePathPrefix);
    if (params.search) search.set("search", params.search);
    return request<MediaLinksPage>(`/api/media-links/page?${search.toString()}`);
  },
  mediaLinkTree: (params: { section: string; prefix?: string; kind?: MediaLinkTreeKindFilter }) => {
    const search = new URLSearchParams({ section: params.section });
    if (params.prefix) search.set("prefix", params.prefix);
    if (params.kind) search.set("kind", params.kind);
    return request<MediaLinkTree>(`/api/media-links/tree?${search.toString()}`);
  },
  storageFiles: (rootType: StorageRootType, orphan = false) => request<StorageFileRow[]>(`/api/storage-files?rootType=${rootType}${orphan ? "&orphan=true" : ""}`),
  damagedFiles: () => request<DamagedFileRow[]>("/api/damaged-files"),
  damagedFilesCsvUrl: "/api/damaged-files.csv",
  orphanReview: (rootType: StorageRootType) => request<OrphanReview>(`/api/orphans?rootType=${rootType}`),
  purgeOrphans: (body: { rootType: StorageRootType; storageFileIds: number[]; folderIds: number[]; mode: OrphanPurgeMode; reRequest: boolean }) =>
    request<{ jobId: number }>("/api/orphans/purge", { method: "POST", body: JSON.stringify(body) }),
  deleteDamagedFiles: (body: { storageFileIds: number[]; mode: OrphanPurgeMode; reRequest: boolean }) =>
    request<{ jobId: number }>("/api/damaged-files/delete", { method: "POST", body: JSON.stringify(body) }),
  reRequests: () => request<ReRequestList>("/api/re-requests"),
  previewReRequests: (storageFileIds: number[]) => request<ReRequestPreview>("/api/re-requests/preview", { method: "POST", body: JSON.stringify({ storageFileIds }) }),
  retryReRequests: (ids: number[] | "all_failed") => request<{ retried: number }>("/api/re-requests/retry", { method: "POST", body: JSON.stringify({ ids }) }),
  heldOrphans: () => request<HeldOrphanFile[]>("/api/orphans/held"),
  restoreHeldOrphans: (operationIds: number[]) =>
    request<{ jobId: number }>("/api/orphans/held/restore", { method: "POST", body: JSON.stringify({ operationIds }) }),
  storageFileTree: (params: { rootType: StorageRootType; prefix?: string; orphan?: boolean }) => {
    const search = new URLSearchParams({ rootType: params.rootType });
    if (params.prefix) search.set("prefix", params.prefix);
    if (params.orphan !== undefined) search.set("orphan", String(params.orphan));
    return request<StorageFileTree>(`/api/storage-files/tree?${search.toString()}`);
  },
  storagePolicies: (policy?: StoragePolicyKind) => request<StoragePolicyTitle[]>(`/api/storage-policies${policy ? `?policy=${policy}` : ""}`),
  setStoragePolicy: (body: { title: string; policy: StoragePolicyKind }) => request<StoragePolicyTitle>("/api/storage-policies", { method: "POST", body: JSON.stringify(body) }),
  setStoragePolicies: (body: { titles: string[]; policy: StoragePolicyKind }) => request<StoragePolicyBulkResult>("/api/storage-policies/bulk", { method: "POST", body: JSON.stringify(body) }),
  defaultPolicyPreview: (section: string) => request<DefaultPolicyPreview>(`/api/storage-policies/default-preview?section=${encodeURIComponent(section)}`),
  applyDefaultPolicy: (section: string) => request<DefaultPolicyApplyResult>("/api/storage-policies/default-apply", { method: "POST", body: JSON.stringify({ section }) }),
  deleteStoragePolicy: (id: number) => request<StoragePolicyTitle>(`/api/storage-policies/${id}`, { method: "DELETE" }),
  startAudit: (body: AuditOptions) => request<{ jobId: number }>("/api/audits", { method: "POST", body: JSON.stringify(body) }),
  audits: () => request<AuditRunRecord[]>("/api/audits"),
  auditByJob: (jobId: number) => request<AuditRunRecord | null>(`/api/audits/job/${jobId}`),
  auditResultPage: (id: number, options: { offset?: number; limit?: number; attentionOnly?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (options.offset) search.set("offset", String(options.offset));
    if (options.limit) search.set("limit", String(options.limit));
    if (options.attentionOnly) search.set("attentionOnly", "true");
    return request<AuditResultPage>(`/api/audits/${id}/results/page${search.size > 0 ? `?${search.toString()}` : ""}`);
  },
  jobs: (options: { activeOnly?: boolean; completedWithinMinutes?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (options.activeOnly) search.set("activeOnly", "true");
    if (options.completedWithinMinutes) search.set("completedWithinMinutes", String(options.completedWithinMinutes));
    if (options.limit) search.set("limit", String(options.limit));
    return request<JobRecord[]>(`/api/jobs${search.size > 0 ? `?${search.toString()}` : ""}`);
  },
  job: (id: number) => request<JobRecord>(`/api/jobs/${id}`),
  copyFailures: (id: number) => request<CopyFailureList>(`/api/jobs/${id}/copy-failures`),
  purgeJobItems: (id: number, input: { outcome: OrphanPurgeItemOutcome; offset?: number; limit?: number }) =>
    request<OrphanPurgeItemPage>(`/api/jobs/${id}/purge-items?outcome=${input.outcome}&offset=${input.offset ?? 0}&limit=${input.limit ?? 100}`),
  copyRetryPlan: (id: number) => request<CopyRetryPlan>(`/api/jobs/${id}/copy-retry`),
  retryFailedCopies: (id: number, choices: { replaceExisting?: boolean; deleteRemoteSources?: boolean } = {}) =>
    request<CopyRetryStarted>(`/api/jobs/${id}/copy-retry`, { method: "POST", body: JSON.stringify(choices) }),
  removeFailedCopySymlinks: (id: number, mediaLinkIds: number[]) =>
    request<{ jobId: number }>(`/api/jobs/${id}/copy-failures/remove-symlinks`, {
      method: "POST",
      body: JSON.stringify({ mediaLinkIds })
    }),
  terminateJob: (id: number) => request<{ ok: true; jobId: number }>(`/api/jobs/${id}/terminate`, { method: "POST" }),
  jobEvents: (id: number, limit = 100) => request<JobEventRecord[]>(`/api/jobs/${id}/events?limit=${limit}`),
  jobEventPage: (id: number, options: { beforeId?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (options.beforeId) search.set("beforeId", String(options.beforeId));
    if (options.limit) search.set("limit", String(options.limit));
    return request<JobEventPage>(`/api/jobs/${id}/events/page${search.size > 0 ? `?${search.toString()}` : ""}`);
  }
};
