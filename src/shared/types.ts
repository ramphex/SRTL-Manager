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

export type JobType = "scan" | "audit" | "copy" | "symlink_cleanup" | "orphan_purge" | "orphan_restore" | "partial_copy_discard" | "path_migration" | "watch_sync" | "backup";

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

export type DefaultStoragePolicy = Exclude<StoragePolicyKind, "unassigned">;

export interface SectionSettings {
  sections: string[];
  sectionTitles?: Record<string, string>;
  sectionTypes?: Record<string, SectionContentType>;
  // Policy given to titles first seen in a folder after it was set. A folder without an entry assigns nothing.
  sectionDefaultPolicies?: Record<string, DefaultStoragePolicy>;
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

export interface RollingAuditSettings {
  // Off by default: a nightly fast audit of local files reads every local byte over time.
  enabled: boolean;
  // Hour of the day (0-23, server local time) the nightly window opens.
  startHour: number;
  // Length of the nightly window in hours (1-12). The audit stops at the end and continues the next night.
  windowHours: number;
}

export interface AuditJobBehaviorSettings {
  defaultMode: AuditMode;
  // Off by default. A manual audit can still turn byte compare on for one run.
  byteCompareWhenSourceKnown: boolean;
  rolling: RollingAuditSettings;
}

export type SymlinkScanSchedulingMode = "single_job" | "per_folder";

export interface ScheduledInventorySettings {
  enabled: boolean;
  // Hour of the day (0-23, server local time) after which the daily full scan is queued.
  hour: number;
}

export interface ScanJobBehaviorSettings {
  symlinkFolderScheduling: SymlinkScanSchedulingMode;
  // Queue the remote storage scan (seconds on a FUSE mount) alongside every symlink scan.
  includeRemoteWithSymlinkScans: boolean;
  scheduledInventory: ScheduledInventorySettings;
}

export interface CleanupSettings {
  // Days purged orphans stay restorable in the holding area before permanent deletion.
  holdDays: number;
  // Delete the remote source once a verified copy to local finishes and nothing else links to it.
  deleteRemoteSourceAfterCopy: boolean;
  // Searches sent to each Radarr or Sonarr instance per minute when deleted files are re-requested.
  reRequestsPerMinute: number;
  // Seconds a purge waits after its last remote delete before it looks at every deleted remote path again. 0 skips the recheck.
  purgeRecheckSeconds: number;
  // Seconds a purge waits after a remote folder's last video is deleted before it looks for another copy at the same path. 0 skips it.
  purgeSettleSeconds: number;
}

export interface AdvancedSettings {
  scan: ScanJobBehaviorSettings;
  copy: CopyJobBehaviorSettings;
  audit: AuditJobBehaviorSettings;
  cleanup: CleanupSettings;
}

export interface ScanStartResult {
  jobId: number;
  jobIds: number[];
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
  // Storage files to audit directly, such as damaged files that no symlink points at.
  storageFileIds?: number[];
  section?: string;
  itemName?: string;
  relativePathPrefix?: string;
  // Set only on the nightly rolling audit, which picks local files oldest-checked first and stops at windowEnd.
  rolling?: { windowStart: string; windowEnd: string };
}

export interface AuditEstimateBucket {
  files: number;
  bytes: number;
}

export interface AuditEstimate {
  mode: AuditMode;
  scoped: boolean;
  local: AuditEstimateBucket;
  remote: AuditEstimateBucket;
  // Files whose recorded copy source would also be read by byte compare.
  withKnownSource: AuditEstimateBucket;
  byteCompare: boolean;
  // Rough wall-clock time for the whole audit at typical read and decode speeds.
  estimatedSeconds: number;
  // Why this audit would be refused, or null when it can start.
  refusal: string | null;
}

export interface RollingAuditCoverage {
  enabled: boolean;
  days: number;
  localFiles: number;
  localBytes: number;
  checkedFiles: number;
  checkedBytes: number;
  neverCheckedFiles: number;
  failedFiles: number;
  // Measured bytes per second of recent nightly runs, or null before the first one.
  measuredBytesPerSecond: number | null;
  // Nights a full pass takes at the current window, or null when the rate is unknown.
  nightsPerFullPass: number | null;
  windowHours: number;
  lastRun: { jobId: number; startedAt: string; finishedAt: string | null; checked: number; failed: number; stopReason: string | null } | null;
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
  sourceTitleRisks?: Array<{
    linkId: number;
    itemName: string;
    relativePath: string;
    sourcePath: string;
    reason: string;
  }>;
  totalSourceTitleBlocks?: number;
}

export interface CopyOptions {
  direction: CopyDirection;
  linkIds?: number[];
  section?: string;
  itemName?: string;
  relativePathPrefix?: string;
  localConflictStrategy?: CopyLocalConflictStrategy;
  allowSourceTitleMismatch?: boolean;
  radarrMonitoring?: boolean;
  sonarrMonitoring?: boolean;
}

export type CopyFailureSymlinkStatus =
  | "eligible"
  | "already_missing"
  | "changed"
  | "superseded"
  | "unavailable"
  | "reconciliation_required"
  | "unidentified";

export interface CopyFailureItem {
  key: string;
  mediaLinkId: number | null;
  copyOperationId: number | null;
  section: string | null;
  itemName: string;
  relativePath: string | null;
  fileName: string | null;
  reason: string;
  symlinkStatus: CopyFailureSymlinkStatus;
  symlinkStatusDetail: string;
}

export interface CopyFailureList {
  jobId: number;
  totalFailures: number;
  eligibleCount: number;
  unidentifiedCount: number;
  items: CopyFailureItem[];
}

export type CopyRetrySkipReason = "already_copied" | "link_gone" | "no_longer_eligible" | "needs_reconciliation" | "already_queued" | "unidentified";

export interface CopyRetrySkip {
  reason: CopyRetrySkipReason;
  count: number;
  /** The active jobs already holding these items, for `already_queued`. */
  jobIds?: number[];
}

export interface CopyRetryPlan {
  jobId: number;
  direction: CopyDirection;
  /** Every failed item in the job, whether or not it can be retried. */
  totalFailed: number;
  retryCount: number;
  skippedCount: number;
  skipped: CopyRetrySkip[];
  /** Items the job never got to because it stopped early. They are not failures, so a retry leaves them out. */
  notReachedCount: number;
  /** The original job replaced existing local files. A retry keeps both unless asked to replace. */
  replaceOffered: boolean;
  /** The original job deleted remote sources and the setting is still on. A retry keeps them unless asked to delete. */
  deleteRemoteSourceOffered: boolean;
  /** Says what would be skipped and why, ready to show. */
  summary: string;
}

export interface CopyRetryStarted {
  jobId: number;
  retried: number;
  skipped: number;
  summary: string;
  localConflictStrategy?: CopyLocalConflictStrategy;
  deleteRemoteSources: boolean;
}

export interface SymlinkCleanupOptions {
  sourceJobId: number;
  linkIds: number[];
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

/** One library folder's copy of a title. Storage policies are set per folder, so the same title can differ between folders. */
export interface StoragePolicyTarget {
  section: string;
  title: string;
}

/** Another folder holding the same title, with the policy that folder's copy has. */
export interface StoragePolicyOtherFolder {
  section: string;
  policy: StoragePolicyKind;
}

export interface StoragePolicyTitle {
  id: number | null;
  title: string;
  normalizedTitle: string;
  /** The folder this policy applies to; null for a saved policy whose title is not in any folder yet. */
  section: string | null;
  policy: StoragePolicyKind;
  category: StoragePolicyCategory;
  sections: string[];
  /** The same title in other folders, each with its own policy. */
  otherFolders: StoragePolicyOtherFolder[];
  /**
   * Folders whose links point at the same files as this folder's links but carry a different policy. Those files
   * stay where they are while any folder still uses them: a copy repoints only this folder's links.
   */
  sharedFileSections: string[];
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
  /** The folders the change applied to. */
  sections: string[];
  items: StoragePolicyTitle[];
}

export interface DefaultPolicyPreview {
  section: string;
  policy: DefaultStoragePolicy;
  unassignedTitles: number;
  radarrReviewTitles: number;
}

export interface DefaultPolicyApplyResult {
  section: string;
  policy: DefaultStoragePolicy;
  assigned: number;
  skippedForRadarrReview: number;
}

export interface StoragePolicyCandidate {
  title: string;
  normalizedTitle: string;
  section: string;
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

export type StorageIntegrity = "ok" | "hollow" | "partial_hollow" | "unknown";

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
  // Bytes stored on disk; null when no scan has recorded it yet.
  allocatedBytes: number | null;
  // Large file with almost nothing stored on disk, usually a sparse placeholder or an interrupted copy.
  hollow: boolean;
  integrity: StorageIntegrity;
  // All-zero samples out of 24 evenly spaced 256 KB reads; null when the file was never sampled.
  zeroSamples: number | null;
  integrityCheckedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  missingSince: string | null;
  updatedAt: string;
  linkCount: number;
  linked: boolean;
}

export type OrphanCategory = "superseded" | "copy_leftover" | "not_in_library" | "srtl_artifact" | "unlinked";

// The category, with "unlinked" told apart by comparing the file's release name with the library's titles.
export type OrphanReviewLabel = Exclude<OrphanCategory, "unlinked"> | "title_in_library" | "episode_not_linked" | "no_title_match";

export type OrphanReleaseStatus = "none_linked" | "partly_linked";

export type OrphanSizeComparison = "larger" | "same" | "smaller";

export interface OrphanReviewItem {
  storageFileId: number;
  rootType: StorageRootType;
  relativePath: string;
  filePath: string;
  section: string;
  itemName: string;
  sizeBytes: number;
  mtimeMs: number;
  category: OrphanCategory;
  protectedReason: string | null;
  hollow: boolean;
  integrity: StorageIntegrity;
  zeroSamples: number | null;
  label: OrphanReviewLabel;
  // The library title this file's release name appears to be; a name comparison, so it can be wrong.
  matchedTitle: string | null;
  // The folder the file arrived in, or the file name for a file with no folder of its own.
  releaseName: string;
  releaseStatus: OrphanReleaseStatus;
  releaseFileCount: number;
  releaseLinkedCount: number;
  // The linked file or files a superseded file is compared with. Null when there is nothing to compare.
  linkedSizeBytes: number | null;
  sizeComparison: OrphanSizeComparison | null;
  // For a multi-episode file: how many of its episodes have a linked file elsewhere.
  episodeCoverage: { linked: number; total: number } | null;
  // A symlink in an extra symlink folder that still points at this file.
  extraLinkPath: string | null;
  // The last purge that deleted this file, or tried to, while storage shows it again now. Absent or null otherwise.
  cameBackAfterPurge?: OrphanCameBackAfterPurge | null;
}

/** A purge that deleted a file storage shows again: "deleted" when it came back after the purge ended, "came_back" when the purge's recheck saw it, "keeps_coming_back" when the purge gave up. */
export interface OrphanCameBackAfterPurge {
  jobId: number;
  at: string;
  outcome: "deleted" | "came_back" | "keeps_coming_back";
}

export interface OrphanLeftoverFolder {
  folderId: number;
  rootType: StorageRootType;
  relativePath: string;
  dirPath: string;
  fileCount: number;
  totalBytes: number;
  newestMtimeMs: number;
  protectedReason: string | null;
}

export interface OrphanReview {
  rootType: StorageRootType;
  items: OrphanReviewItem[];
  // Folders whose whole subtree holds no video, such as leftover subtitles, artwork, samples, or empty folders.
  leftoverFolders: OrphanLeftoverFolder[];
  summary: Array<{ category: OrphanCategory; count: number; sizeBytes: number; purgeableCount: number }>;
  labelSummary: Array<{ label: OrphanReviewLabel; count: number; sizeBytes: number; purgeableCount: number }>;
  hollowCount: number;
  // Partially hollow files: allocated, but with zero-filled gaps found by sampling.
  damagedCount: number;
  symlinkInventoryAt: string | null;
  storageInventoryAt: string | null;
  staleWarning: string | null;
  // Informational only: purges re-check every file on disk.
  storageStaleWarning: string | null;
  // Symlink folders kept by other tools. Any problem here blocks purging.
  extraSymlinks: { folders: string[]; linkCount: number; unmatchedCount: number; problems: string[] };
  // Files and folders left out of `items` and `leftoverFolders` because a symlink uses them, so SRTL would never purge them.
  skippedInUse: OrphanSkippedInUse;
  // Listed files that a purge deleted before and that storage shows again. Absent from older servers.
  cameBackAfterPurgeCount?: number;
  holdDays: number;
}

/** Why an in-use item was left out of the review: a link in the library folders, or one in an extra symlink folder. */
export type OrphanInUseReason = "library_link" | "extra_link";

export interface OrphanSkippedInUse {
  total: number;
  files: number;
  folders: number;
  byReason: Record<OrphanInUseReason, number>;
}

/** The progress an orphan purge or damaged file delete job records. Read it from `JobRecord.progress`; `JobRecord.status` says whether it failed. */
export interface OrphanPurgeJobProgress {
  options: { rootType: StorageRootType; mode: OrphanPurgeMode; total: number; reRequest: boolean; source?: "damaged" };
  current: number;
  total: number;
  held: number;
  deleted: number;
  alreadyMissing: number;
  failed: number;
  // Deleted remote files or folders that were back when the purge looked again after the delay. Not counted in deleted.
  // Absent on jobs from before the recheck existed.
  cameBack?: number;
  // Deleted, after another copy appeared at the same path and was deleted too. Counted in deleted as well.
  resurfacedDeleted?: number;
  // Left in place because another copy was back after every delete. Not counted in deleted or failed.
  keepsComingBack?: number;
  // Deleted, but storage still lists them although they cannot be opened. Counted in deleted as well.
  listedNotReadable?: number;
  remaining: number;
  stage: "preparing" | "purging" | "rechecking" | "cancelled" | "failed" | "partially_failed" | "completed";
  message: string;
  // The first item that was not purged and why. Absent when nothing failed.
  firstError?: { filePath: string; message: string };
  // The first deleted item that came back, and what was found. Absent when none did.
  firstCameBack?: { filePath: string; message: string };
  // The recheck of deleted remote paths: when it runs (or ran), the delay it waited, and how far it got.
  recheck?: { at: string; delaySeconds: number; total: number; checked: number };
}

export type OrphanPurgeMode = "hold" | "delete";

/** Progress of a job that restores held orphans from the holding area. */
export interface OrphanRestoreJobProgress {
  options: { total: number };
  current: number;
  total: number;
  restored: number;
  failed: number;
  remaining: number;
  stage: "queued" | "restoring" | "cancelled" | "failed" | "partially_failed" | "completed";
  message: string;
  // The first held file that was not restored and why. Absent when nothing failed.
  firstError?: { filePath: string | null; message: string };
}

/**
 * Which of a purge job's items to list: failed, moved to the holding area, deleted but back at the recheck (came_back),
 * left in place because another copy kept appearing (keeps_coming_back), or deleted after another copy appeared (resurfaced).
 */
export type OrphanPurgeItemOutcome = "failed" | "held" | "came_back" | "keeps_coming_back" | "resurfaced";

export interface OrphanPurgeItem {
  operationId: number;
  targetKind: "file" | "folder";
  rootType: StorageRootType;
  filePath: string;
  sizeBytes: number;
  stage: "planned" | "held" | "deleted" | "already_missing" | "failed" | "came_back" | "keeps_coming_back" | "restored" | "expired";
  errorMessage: string | null;
  // Something worth knowing about an item that did not fail, such as storage still listing a file it cannot open.
  note: string | null;
  // How many times the path was deleted; more than 1 when another copy appeared at it.
  deleteRounds: number;
  heldPath: string | null;
  purgeAfter: string | null;
  completedAt: string | null;
}

export interface OrphanPurgeItemPage {
  jobId: number;
  outcome: OrphanPurgeItemOutcome;
  items: OrphanPurgeItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface HeldOrphanFile {
  operationId: number;
  jobId: number;
  rootType: StorageRootType;
  filePath: string;
  heldPath: string;
  sizeBytes: number;
  heldAt: string;
  purgeAfter: string;
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
  /** Immutable admission options. Legacy records may expose these through progress.options instead. */
  options?: unknown;
  /** True when the job owns an immutable selected-media snapshot, including an intentionally empty selection. */
  selectionFrozen?: boolean;
  selection?: JobSelectionSummary;
  progress: unknown;
}

export interface JobSelectionTitle {
  section: string;
  itemName: string;
  count: number;
}

export interface JobSelectionSummary {
  total: number;
  titles: JobSelectionTitle[];
  unavailable: number;
  /** Additional title groups omitted from the bounded job-list payload. */
  omittedTitles?: number;
  /** Present only for active jobs so the client can show advisory per-item locks. */
  linkIds?: number[];
}

export interface CopyReconciliationRecord {
  id: number;
  jobId: number;
  mediaLinkId: number;
  linkPath: string;
  errorMessage: string | null;
  updatedAt: string;
}

export interface CopyReconciliationState {
  unresolved: CopyReconciliationRecord[];
  unresolvedCount: number;
  resolvedNow: number;
}

export interface PartialCopyDiscardPreview {
  operationId: number;
  jobId: number;
  mediaLinkId: number;
  linkPath: string;
  originalTargetPath: string;
  currentLinkTarget: string | null;
  destinationPath: string;
  destinationExists: boolean | null;
  tempPath: string | null;
  tempSizeBytes: number | null;
  displacedPath: string | null;
  eligible: boolean;
  blockers: string[];
}

export interface PartialCopyDiscardRequest {
  tempPath: string;
  tempSizeBytes: number;
}

/** Progress of a job that discards one interrupted copy's temporary file. */
export interface PartialCopyDiscardJobProgress {
  options: { operationId: number; copyJobId: number };
  stage: "queued" | "discarding" | "failed" | "completed";
  message: string;
  removedBytes?: number;
}

/** The answer to a discard request: the job that will do it. */
export interface PartialCopyDiscardQueued {
  operationId: number;
  jobId: number;
}

export interface PartialCopyDiscardResult {
  operationId: number;
  jobId: number;
  removedTempPath: string;
  removedBytes: number;
  state: CopyReconciliationState;
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
  // Nightly rolling audit runs: bytes read and why the run stopped (window_end, all_checked, yielded, cancelled).
  rolling?: boolean;
  checkedBytes?: number;
  stopReason?: string | null;
}

export interface AuditResultRecord {
  id: number;
  auditRunId: number;
  linkPath: string;
  targetPath: string;
  sourcePath: string | null;
  status: "pass" | "warning" | "fail" | "source_issue";
  ffmpegStatus: "pass" | "fail";
  cmpStatus: "pass" | "fail" | "source_unknown" | "source_missing" | "source_error" | "skipped";
  message: string;
  createdAt: string;
}

export interface AuditResultPage {
  results: AuditResultRecord[];
  total: number;
  offset: number;
  hasMore: boolean;
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

export interface DamagedFileRow {
  storageFileId: number;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  sizeBytes: number;
  allocatedBytes: number | null;
  // Share of the file stored on disk, 0-100.
  storedPercent: number | null;
  // audit_failed: the last audit of this file failed; the other values come from scan sampling.
  integrity: "hollow" | "partial_hollow" | "audit_failed";
  zeroSamples: number | null;
  zeroSamplesTotal: number;
  checkedAt: string | null;
  linked: boolean;
  // A current remote file with the same relative path, usable as a source for a fresh copy.
  remoteCopyExists: boolean;
  // Why this file cannot be deleted right now, the same rules orphans follow.
  protectedReason: string | null;
  // The last audit of this file, when one has run since the file last changed.
  audit: { status: string; mode: string; message: string | null; checkedAt: string } | null;
}
