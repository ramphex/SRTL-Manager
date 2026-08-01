export type LinkKind = "remote" | "local" | "broken" | "other" | "non_media";
export type MediaLinkTreeKindFilter = LinkKind | "mixed";

export type StorageRootType = "local" | "remote";

export type StorageLocationKey = "location_1" | "location_2";

export interface StorageLocationSetting {
  key: StorageLocationKey;
  rootType: StorageRootType;
  displayName: string;
  path: string;
}

export interface StorageLocationsSettings {
  locations: StorageLocationSetting[];
}

export interface StorageLocationNamesUpdate {
  locations: Array<Pick<StorageLocationSetting, "key" | "displayName">>;
}

export type StoragePolicyKind = "unassigned" | StorageLocationKey;

export type OnboardingPolicyMode = "match_current_locations" | "leave_unassigned";

export type OnboardingPhase = "account_required" | "configuration_required" | "queued" | "scanning" | "failed" | "completed";

export type JobStatus = "queued" | "running" | "completed" | "partially_failed" | "failed" | "cancelled";

export type JobType = "scan" | "audit" | "copy" | "path_migration";

export type AuditMode = "fast" | "deep";

export type CopyVerificationProfile = "off" | "fast" | "balanced" | "deep" | "custom";

export type CopyMediaValidationMode = "off" | AuditMode;


export type SectionContentType = "shows" | "movies" | "other";

export type TimeFormatPreference = "12h" | "24h";

export interface UserPreferences {
  timeFormat: TimeFormatPreference;
  autoOpenTaskStatus: boolean;
  recentJobsCompletedWindowMinutes: number;
}

export interface PathsSettings {
  symlinkDir: string;
  localDir: string;
  remoteDir: string;
}

export type ManagedPathRoot = "symlink" | "local" | "remote";

export type PathRootIdentityMatch = "same" | "different" | "unknown";

export interface PathMountIdentity {
  mountPoint: string;
  root: string;
  filesystemType: string;
  source: string;
}

export interface PathRootIdentity {
  available: boolean;
  realPath: string | null;
  device: string | null;
  inode: string | null;
  mount: PathMountIdentity | null;
  error: string | null;
}

export interface PathRootChange {
  root: ManagedPathRoot;
  label: string;
  activePath: string;
  detectedPath: string;
  changed: boolean;
  identityMatch: PathRootIdentityMatch;
  activeIdentity: PathRootIdentity | null;
  detectedIdentity: PathRootIdentity | null;
}

export type PathMigrationStatus = "pending" | "planning" | "planned" | "queued" | "running" | "rollback_pending" | "failed" | "completed" | "cancelled";

export interface PathMigrationIssue {
  id: number;
  itemName: string;
  linkPath: string;
  message: string;
}

export interface PathMigrationSummary {
  totalLinks: number;
  affectedLinks: number;
  readyLinks: number;
  blockedLinks: number;
  repointLinks: number;
  rebaseLinkPaths: number;
  localFiles: number;
  remoteFiles: number;
  copySources: number;
  activeJobs: number;
}

export type PathConfigurationStatus = "ready" | "invalid_environment" | "change_pending" | "planning" | "ready_to_apply" | "migrating" | "failed";

export interface PathMigrationRecord {
  id: number;
  status: PathMigrationStatus;
  jobId: number | null;
  errorMessage: string | null;
  createdAt: string;
  plannedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: PathMigrationSummary;
  issues: PathMigrationIssue[];
}

export interface PathConfigurationState {
  status: PathConfigurationStatus;
  blocking: boolean;
  activePaths: PathsSettings | null;
  detectedPaths: PathsSettings;
  environmentErrors: string[];
  changes: PathRootChange[];
  migration: PathMigrationRecord | null;
}

export interface SectionSettings {
  sections: string[];
  sectionTitles?: Record<string, string>;
  sectionTypes?: Record<string, SectionContentType>;
}

export interface OnboardingPathCheck {
  root: ManagedPathRoot;
  label: string;
  path: string;
  ready: boolean;
  message: string | null;
}

export interface OnboardingPolicyResult {
  totalTitles: number;
  assignedLocalTitles: number;
  assignedRemoteTitles: number;
  unassignedTitles: number;
  mixedTitles: number;
  localSymlinks: number;
  remoteSymlinks: number;
}

export interface OnboardingState {
  required: boolean;
  phase: OnboardingPhase;
  policyMode: OnboardingPolicyMode | null;
  initialScanJobId: number | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  policyResult: OnboardingPolicyResult | null;
  paths: PathsSettings;
  pathChecks: OnboardingPathCheck[];
  storageLocations: StorageLocationsSettings;
  sections: SectionSettings;
  detectedSections: string[];
}

export interface OnboardingStartRequest {
  storageLocations: StorageLocationNamesUpdate;
  sections: SectionSettings;
  policyMode: OnboardingPolicyMode;
}

export interface ScanTitleScope {
  section: string;
  itemName: string;
}

export interface ScanOptions {
  scanSymlinks: boolean;
  scanLocal: boolean;
  scanRemote: boolean;
  symlinkSections?: string[];
  localSections?: string[];
  titleScopes?: ScanTitleScope[];
  /** Legacy scan folder scope; accepted as a fallback for older clients. */
  sections?: string[];
}

export interface AuditSettings {
  sections: string[];
  targets: StorageRootType[];
}

export interface CopyJobBehaviorSettings {
  profile: CopyVerificationProfile;
  byteCompare: boolean;
  mediaValidation: CopyMediaValidationMode;
}

export interface AuditJobBehaviorSettings {
  defaultMode: AuditMode;
  byteCompareWhenSourceKnown: boolean;
}

export interface AdvancedSettings {
  copy: CopyJobBehaviorSettings;
  audit: AuditJobBehaviorSettings;
}

export interface InventoryScanTimestamps {
  symlinkSections: Record<string, string | null>;
  localSections: Record<string, string | null>;
  remoteRoot: string | null;
}

export interface AuditOptions {
  mode: AuditMode;
  sections?: string[];
  targets?: StorageRootType[];
  byteCompare?: boolean;
  linkIds?: number[];
  section?: string;
  itemName?: string;
  relativePathPrefix?: string;
}

export type CopyDirection = "to_local" | "to_remote";

export type CopyLocalConflictStrategy = "keep_both" | "replace";

export interface CopyLocalConflictCandidate {
  filePath: string;
  relativePath: string;
  sizeBytes: number;
  source: "destination" | "copy_history" | "inventory" | "filesystem";
}

export interface CopyLocalConflict {
  linkId: number;
  section: string;
  itemName: string;
  relativePath: string;
  linkPath: string;
  destinationPath: string;
  candidates: CopyLocalConflictCandidate[];
}

export interface CopyConflictPreview {
  conflicts: CopyLocalConflict[];
  totalConflicts: number;
  totalCandidates: number;
}

export interface CopyOptions {
  direction: CopyDirection;
  linkIds?: number[];
  section?: string;
  itemName?: string;
  relativePathPrefix?: string;
  localConflictStrategy?: CopyLocalConflictStrategy;
}

export interface SectionSummary {
  section: string;
  title: string;
  type: SectionContentType;
  totalLinks: number;
  itemCount: number;
  seasonCount: number;
  episodeCount: number;
  remoteLinks: number;
  localLinks: number;
  brokenLinks: number;
  otherLinks: number;
  nonMediaLinks: number;
  actionableRemoteLinks: number;
  actionableLocalLinks: number;
  assignedRemoteLinks: number;
  unassignedRemoteLinks: number;
  unassignedLocalLinks: number;
}

export interface InventorySummary {
  totalLinks: number;
  remoteLinks: number;
  localLinks: number;
  brokenLinks: number;
  otherLinks: number;
  nonMediaLinks: number;
  actionableRemoteLinks: number;
  actionableLocalLinks: number;
  assignedRemoteLinks: number;
  unassignedRemoteLinks: number;
  unassignedLocalLinks: number;
  localFiles: number;
  remoteFiles: number;
  actionableRemoteFiles: number;
  actionableLocalFiles: number;
  assignedRemoteFiles: number;
  unassignedRemoteFiles: number;
  unassignedLocalFiles: number;
  localOrphanFiles: number;
  remoteOrphanFiles: number;
  missingLinks: number;
  missingLocalFiles: number;
  missingRemoteFiles: number;
}

export type AppReleaseChannel = "stable" | "beta";

export type AppVersionStatus = "up_to_date" | "update_available" | "unavailable";

export interface AppReleaseInfo {
  channel: AppReleaseChannel;
  latestVersion: string | null;
  updateAvailable: boolean;
  status: AppVersionStatus;
  releaseUrl: string | null;
  releaseNotes: string | null;
  message: string;
}

export interface AppVersionInfo {
  currentVersion: string;
  currentChannel: AppReleaseChannel;
  currentChannelLabel: string;
  stable: AppReleaseInfo;
  beta: AppReleaseInfo;
  latestVersion: string | null;
  updateAvailable: boolean;
  status: AppVersionStatus;
  releaseUrl: string | null;
  checkedAt: string;
  message: string;
}

export type StoragePolicyCategory = "movies" | "shows" | "mixed" | "other" | "unmatched";

export interface StoragePolicyTitle {
  id: number | null;
  title: string;
  normalizedTitle: string;
  policy: StoragePolicyKind;
  category: StoragePolicyCategory;
  sections: string[];
  linkCount: number;
  remoteLinkCount: number;
  localLinkCount: number;
  fileCount: number;
  remoteFileCount: number;
  localFileCount: number;
  sectionCount: number;
  source: string;
  updatedAt: string | null;
}

export interface StoragePolicyBulkResult {
  updated: number;
  policy: StoragePolicyKind;
  items: StoragePolicyTitle[];
}

export interface StoragePolicyCandidate {
  title: string;
  normalizedTitle: string;
  category: StoragePolicyCategory;
  sections: string[];
  linkCount: number;
  remoteLinkCount: number;
  localLinkCount: number;
  fileCount: number;
  remoteFileCount: number;
  localFileCount: number;
  sectionCount: number;
}

export interface MediaLinkRow {
  id: number;
  section: string;
  itemName: string;
  relativePath: string;
  linkPath: string;
  targetPath: string;
  kind: LinkKind;
  targetExists: boolean;
  isMedia: boolean;
  storagePolicy: StoragePolicyKind;
  resolvedStorageFileId: number | null;
  sizeBytes: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  missingSince: string | null;
  updatedAt: string;
}

export interface MediaLinksPage {
  rows: MediaLinkRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export type MediaLinkTreeNodeType = "folder" | "link";

export interface MediaLinkTreeNode {
  type: MediaLinkTreeNodeType;
  name: string;
  path: string;
  totalLinks: number;
  childFolderCount: number;
  remoteLinks: number;
  localLinks: number;
  brokenLinks: number;
  otherLinks: number;
  nonMediaLinks: number;
  actionableRemoteLinks: number;
  actionableLocalLinks: number;
  assignedRemoteLinks: number;
  unassignedRemoteLinks: number;
  unassignedLocalLinks: number;
  link: MediaLinkRow | null;
}

export interface MediaLinkTree {
  section: string;
  prefix: string;
  parentPrefix: string | null;
  totalLinks: number;
  nodes: MediaLinkTreeNode[];
}

export interface StorageFileRow {
  id: number;
  rootType: StorageRootType;
  rootPath: string;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  storagePolicy: StoragePolicyKind;
  sizeBytes: number;
  mtimeMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  missingSince: string | null;
  updatedAt: string;
  linkCount: number;
  linked: boolean;
}

export type StorageFileTreeNodeType = "folder" | "file";

export interface StorageFileTreeNode {
  type: StorageFileTreeNodeType;
  name: string;
  path: string;
  totalFiles: number;
  childFolderCount: number;
  linkedFiles: number;
  orphanFiles: number;
  actionableRemoteFiles: number;
  actionableLocalFiles: number;
  assignedRemoteFiles: number;
  unassignedRemoteFiles: number;
  unassignedLocalFiles: number;
  sizeBytes: number;
  mtimeMs: number | null;
  file: StorageFileRow | null;
}

export interface StorageFileTree {
  rootType: StorageRootType;
  prefix: string;
  parentPrefix: string | null;
  totalFiles: number;
  nodes: StorageFileTreeNode[];
}

export interface JobRecord {
  id: number;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lockedBy?: string | null;
  lockedAt?: string | null;
  heartbeatAt?: string | null;
  cancelRequestedAt?: string | null;
  progress: unknown;
}

export interface ScanRunRecord {
  id: number | null;
  jobId: number;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  totalLinks: number;
  remoteLinks: number;
  localLinks: number;
  brokenLinks: number;
  otherLinks: number;
  nonMediaLinks: number;
  actionableRemoteLinks: number;
  actionableLocalLinks: number;
  assignedRemoteLinks: number;
  unassignedRemoteLinks: number;
  unassignedLocalLinks: number;
  localFiles: number;
  remoteFiles: number;
  actionableRemoteFiles: number;
  actionableLocalFiles: number;
  assignedRemoteFiles: number;
  unassignedRemoteFiles: number;
  unassignedLocalFiles: number;
  localOrphanFiles: number;
  remoteOrphanFiles: number;
  missingLinks: number;
  missingLocalFiles: number;
  missingRemoteFiles: number;
  options?: ScanOptions | null;
}

export interface AuditRunRecord {
  id: number;
  jobId: number;
  mode: AuditMode;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  checked: number;
  passed: number;
  failed: number;
  sourceUnknown: number;
  sourceMissing: number;
  sourceCompareErrors: number;
  byteMismatches: number;
  targetValidationFailures: number;
  errorMessage: string | null;
  options?: AuditOptions | null;
}

export interface AuditResultRecord {
  id: number;
  auditRunId: number;
  linkPath: string;
  targetPath: string;
  sourcePath: string | null;
  status: "pass" | "fail" | "source_issue";
  ffmpegStatus: "pass" | "fail";
  cmpStatus: "pass" | "fail" | "source_unknown" | "source_missing" | "source_error" | "skipped";
  message: string;
  createdAt: string;
}

export interface JobEventRecord {
  id: number;
  jobId: number;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  data: unknown;
}

export interface JobEventPage {
  events: JobEventRecord[];
  total: number;
  hasOlder: boolean;
}
