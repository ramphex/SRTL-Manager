import type {
  AuditOptions,
  AuditResultPage,
  AuditRunRecord,
  AuditSettings,
  AdvancedSettings,
  AppVersionInfo,
  CopyConflictPreview,
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
  PathsSettings,
  PathConfigurationState,
  ScanRunRecord,
  ScanOptions,
  ScanStartResult,
  SectionSettings,
  SectionSummary,
  StoragePolicyKind,
  StoragePolicyBulkResult,
  StoragePolicyTitle,
  StorageFileRow,
  StorageFileTree,
  StorageLocationNamesUpdate,
  StorageLocationsSettings,
  StorageRootType,
  UserPreferences
} from "../shared/types";

type ApiErrorPayload = {
  error?: string;
  issues?: Array<{ message?: string }>;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(payload.error ?? payload.issues?.[0]?.message ?? `${response.status} ${response.statusText}`);
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
  me: () => request<{ authenticated: boolean; setupRequired: boolean; user: { id: number; username: string } | null }>("/api/auth/me"),
  setup: (body: { username: string; password: string; confirmPassword: string }) =>
    request<{ ok: true }>("/api/auth/setup", { method: "POST", body: JSON.stringify(body) }),
  login: (body: { username: string; password: string }) => request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  updateUser: (body: { username: string; currentPassword: string; newPassword?: string; confirmNewPassword?: string }) =>
    request<{ user: { id: number; username: string } }>("/api/auth/user", { method: "PUT", body: JSON.stringify(body) }),
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
  storageFileTree: (params: { rootType: StorageRootType; prefix?: string; orphan?: boolean }) => {
    const search = new URLSearchParams({ rootType: params.rootType });
    if (params.prefix) search.set("prefix", params.prefix);
    if (params.orphan !== undefined) search.set("orphan", String(params.orphan));
    return request<StorageFileTree>(`/api/storage-files/tree?${search.toString()}`);
  },
  storagePolicies: (policy?: StoragePolicyKind) => request<StoragePolicyTitle[]>(`/api/storage-policies${policy ? `?policy=${policy}` : ""}`),
  setStoragePolicy: (body: { title: string; policy: StoragePolicyKind }) => request<StoragePolicyTitle>("/api/storage-policies", { method: "POST", body: JSON.stringify(body) }),
  setStoragePolicies: (body: { titles: string[]; policy: StoragePolicyKind }) => request<StoragePolicyBulkResult>("/api/storage-policies/bulk", { method: "POST", body: JSON.stringify(body) }),
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
  terminateJob: (id: number) => request<{ ok: true; jobId: number }>(`/api/jobs/${id}/terminate`, { method: "POST" }),
  jobEvents: (id: number, limit = 100) => request<JobEventRecord[]>(`/api/jobs/${id}/events?limit=${limit}`),
  jobEventPage: (id: number, options: { beforeId?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (options.beforeId) search.set("beforeId", String(options.beforeId));
    if (options.limit) search.set("limit", String(options.limit));
    return request<JobEventPage>(`/api/jobs/${id}/events/page${search.size > 0 ? `?${search.toString()}` : ""}`);
  }
};
