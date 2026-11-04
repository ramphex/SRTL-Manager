import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, primaryKey, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

// Radarr movie ids are only unique within one Radarr instance.
export const radarrMovies = pgTable("radarr_movies", {
  instanceId: text("instance_id").notNull(),
  movieId: integer("movie_id").notNull(),
  tmdbId: integer("tmdb_id").notNull(),
  title: text("title").notNull(),
  folderPath: text("folder_path").notNull(),
  section: text("section"),
  itemName: text("item_name"),
  tags: text("tags").notNull(),
  managed: boolean("managed").notNull().default(false),
  syncedPolicy: text("synced_policy"),
  syncedAt: text("synced_at"),
  lastError: text("last_error"),
  nextAttemptAt: text("next_attempt_at"),
  attempts: integer("attempts").notNull().default(0),
  observedPolicyMarker: text("observed_policy_marker"),
  monitored: boolean("monitored")
}, (table) => [
  primaryKey({ columns: [table.instanceId, table.movieId] }),
  index("radarr_movies_section_item_idx").on(table.section, table.itemName)
]);

export const radarrCopyJobs = pgTable("radarr_copy_jobs", {
  instanceId: text("instance_id").notNull(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  handledAt: text("handled_at").notNull()
}, (table) => [primaryKey({ columns: [table.instanceId, table.jobId] })]);

export const radarrMonitorUpdates = pgTable("radarr_monitor_updates", {
  id: serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  copyJobId: integer("copy_job_id").references(() => jobs.id, { onDelete: "set null" }),
  movieId: integer("movie_id").notNull(),
  title: text("title").notNull(),
  monitored: boolean("monitored").notNull(),
  // Radarr's monitored state when the update was queued, restored if a cancelled copy is rolled back.
  previousMonitored: boolean("previous_monitored"),
  createdAt: text("created_at").notNull(),
  processedAt: text("processed_at"),
  nextAttemptAt: text("next_attempt_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error")
}, (table) => [
  // A copy changes a movie's monitoring once, and restores it at most once if the copy is rolled back.
  uniqueIndex("radarr_monitor_updates_copy_movie_idx").on(table.copyJobId, table.instanceId, table.movieId, table.monitored).where(sql`copy_job_id is not null`)
]);

export const radarrEvents = pgTable("radarr_events", {
  id: serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  movieId: integer("movie_id").notNull(),
  title: text("title").notNull(),
  eventType: text("event_type").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
  nextAttemptAt: text("next_attempt_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" })
}, (table) => [uniqueIndex("radarr_events_instance_fingerprint_idx").on(table.instanceId, table.fingerprint)]);

// Sonarr series ids are only unique within one Sonarr instance.
export const sonarrSeries = pgTable("sonarr_series", {
  instanceId: text("instance_id").notNull(),
  seriesId: integer("series_id").notNull(),
  tvdbId: integer("tvdb_id").notNull(),
  title: text("title").notNull(),
  folderPath: text("folder_path").notNull(),
  section: text("section"),
  itemName: text("item_name"),
  tags: text("tags").notNull(),
  managed: boolean("managed").notNull().default(false),
  syncedPolicy: text("synced_policy"),
  syncedAt: text("synced_at"),
  lastError: text("last_error"),
  nextAttemptAt: text("next_attempt_at"),
  attempts: integer("attempts").notNull().default(0),
  observedPolicyMarker: text("observed_policy_marker"),
  monitored: boolean("monitored")
}, (table) => [
  primaryKey({ columns: [table.instanceId, table.seriesId] }),
  index("sonarr_series_section_item_idx").on(table.section, table.itemName)
]);

export const sonarrCopyJobs = pgTable("sonarr_copy_jobs", {
  instanceId: text("instance_id").notNull(),
  jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  handledAt: text("handled_at").notNull()
}, (table) => [primaryKey({ columns: [table.instanceId, table.jobId] })]);

// Episode files a copy committed (or, with a skip reason, did not), waiting to be matched to Sonarr episode ids.
export const sonarrCopiedFiles = pgTable("sonarr_copied_files", {
  id: serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  copyJobId: integer("copy_job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  seriesId: integer("series_id").notNull(),
  mediaLinkId: integer("media_link_id").notNull(),
  // Relative to the series folder, as Sonarr reports episode file paths.
  relativePath: text("relative_path").notNull(),
  monitored: boolean("monitored").notNull(),
  skipReason: text("skip_reason"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  nextAttemptAt: text("next_attempt_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error")
}, (table) => [uniqueIndex("sonarr_copied_files_copy_link_idx").on(table.copyJobId, table.instanceId, table.mediaLinkId)]);

export const sonarrMonitorUpdates = pgTable("sonarr_monitor_updates", {
  id: serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  copyJobId: integer("copy_job_id").references(() => jobs.id, { onDelete: "set null" }),
  seriesId: integer("series_id").notNull(),
  episodeId: integer("episode_id").notNull(),
  mediaLinkId: integer("media_link_id"),
  title: text("title").notNull(),
  monitored: boolean("monitored").notNull(),
  // The episode's monitored state in Sonarr when the update was queued, restored if a cancelled copy is rolled back.
  previousMonitored: boolean("previous_monitored"),
  createdAt: text("created_at").notNull(),
  processedAt: text("processed_at"),
  nextAttemptAt: text("next_attempt_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error")
}, (table) => [
  // A copy changes an episode's monitoring once, and restores it at most once if the copy is rolled back.
  uniqueIndex("sonarr_monitor_updates_copy_episode_idx").on(table.copyJobId, table.instanceId, table.episodeId, table.monitored).where(sql`copy_job_id is not null`)
]);

export const sonarrEvents = pgTable("sonarr_events", {
  id: serial("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  seriesId: integer("series_id").notNull(),
  episodeFileId: integer("episode_file_id"),
  title: text("title").notNull(),
  eventType: text("event_type").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
  nextAttemptAt: text("next_attempt_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" })
}, (table) => [uniqueIndex("sonarr_events_instance_fingerprint_idx").on(table.instanceId, table.fingerprint)]);

export const pathConfigurations = pgTable("path_configurations", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(),
  symlinkDir: text("symlink_dir").notNull(),
  localDir: text("local_dir").notNull(),
  remoteDir: text("remote_dir").notNull(),
  symlinkIdentity: text("symlink_identity").notNull(),
  localIdentity: text("local_identity").notNull(),
  remoteIdentity: text("remote_identity").notNull(),
  createdAt: text("created_at").notNull(),
  appliedAt: text("applied_at")
});

export const pathMigrations = pgTable("path_migrations", {
  id: serial("id").primaryKey(),
  sourceConfigId: integer("source_config_id"),
  targetConfigId: integer("target_config_id").notNull(),
  status: text("status").notNull(),
  jobId: integer("job_id"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  plannedAt: text("planned_at"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at")
});

export const pathMigrationItems = pgTable("path_migration_items", {
  id: serial("id").primaryKey(),
  migrationId: integer("migration_id").notNull(),
  mediaLinkId: integer("media_link_id").notNull(),
  itemName: text("item_name").notNull(),
  currentLinkPath: text("current_link_path").notNull(),
  linkPathBefore: text("link_path_before").notNull(),
  linkPathAfter: text("link_path_after").notNull(),
  targetPathBefore: text("target_path_before").notNull(),
  targetPathAfter: text("target_path_after").notNull(),
  targetChanged: boolean("target_changed").notNull(),
  expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }),
  targetIdentity: text("target_identity"),
  validationStatus: text("validation_status").notNull(),
  message: text("message").notNull(),
  appliedAt: text("applied_at"),
  rolledBackAt: text("rolled_back_at")
});

export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  /** One of `accountRoles`. The database keeps exactly one owner. */
  role: text("role").notNull().default("moderator"),
  /** Set by a temporary password; nothing but changing it works until it is changed. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** Username of whoever created the account; null for the owner made at setup. */
  createdBy: text("created_by"),
  disabledAt: text("disabled_at"),
  disabledBy: text("disabled_by"),
  lastSignInAt: text("last_sign_in_at")
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    id: serial("id").notNull(),
    userId: integer("user_id").notNull(),
    /** Absolute end of the session, set at sign-in. */
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    /** Idle deadline, moved forward when the session is used. Null for sessions from before migration 25 until first use. */
    idleExpiresAt: text("idle_expires_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** When a cookie under the pre-`__Host-` name was last exchanged for the current name. */
    cookieReissuedAt: text("cookie_reissued_at")
  },
  (table) => [
    index("sessions_expires_idx").on(table.expiresAt),
    uniqueIndex("sessions_id_idx").on(table.id),
    index("sessions_user_idx").on(table.userId)
  ]
);

/** Sign-ins, failures, lockouts, setup, account changes and session revocations. */
export const securityEvents = pgTable(
  "security_events",
  {
    id: serial("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    event: text("event").notNull(),
    userId: integer("user_id"),
    username: text("username"),
    sessionId: integer("session_id"),
    /** Client address as resolved through the trusted proxies. */
    ip: text("ip"),
    /** Address of the peer that opened the connection. */
    socketIp: text("socket_ip"),
    userAgent: text("user_agent"),
    details: text("details").notNull().default("{}")
  },
  (table) => [index("security_events_created_idx").on(table.createdAt, table.id)]
);

export const sections = pgTable("sections", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name"),
  contentType: text("content_type"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const mediaLinks = pgTable(
  "media_links",
  {
    id: serial("id").primaryKey(),
    section: text("section").notNull(),
    itemName: text("item_name").notNull(),
    relativePath: text("relative_path").notNull(),
    linkPath: text("link_path").notNull(),
    targetPath: text("target_path").notNull(),
    kind: text("kind").notNull(),
    targetExists: boolean("target_exists").notNull(),
    isMedia: boolean("is_media").notNull(),
    storagePolicy: text("storage_policy").notNull().default("unassigned"),
    resolvedStorageFileId: integer("resolved_storage_file_id"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    firstSeenAt: text("first_seen_at"),
    lastSeenAt: text("last_seen_at"),
    lastChangedAt: text("last_changed_at"),
    missingSince: text("missing_since"),
    lastSeenJobId: integer("last_seen_job_id"),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("media_links_link_path_idx").on(table.linkPath), index("media_links_target_path_idx").on(table.targetPath)]
);

export const storageFiles = pgTable(
  "storage_files",
  {
    id: serial("id").primaryKey(),
    rootType: text("root_type").notNull(),
    rootPath: text("root_path").notNull(),
    section: text("section").notNull().default(""),
    itemName: text("item_name").notNull().default(""),
    relativePath: text("relative_path").notNull(),
    filePath: text("file_path").notNull(),
    storagePolicy: text("storage_policy").notNull().default("unassigned"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull(),
    // Bytes actually stored on disk (stat blocks * 512); null until a scan records it.
    allocatedBytes: bigint("allocated_bytes", { mode: "number" }),
    // ok | hollow | partial_hollow | unknown; null until a scan classifies the file. Zero samples are counted out of 24.
    integrity: text("integrity"),
    integrityZeroSamples: integer("integrity_zero_samples"),
    integrityCheckedAt: text("integrity_checked_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastChangedAt: text("last_changed_at").notNull(),
    missingSince: text("missing_since"),
    lastSeenJobId: integer("last_seen_job_id").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("storage_files_file_path_idx").on(table.filePath)]
);

// Storage folders whose whole subtree holds no media file, found by the last storage scan of their scope.
export const storageLeftoverFolders = pgTable(
  "storage_leftover_folders",
  {
    id: serial("id").primaryKey(),
    rootType: text("root_type").notNull(),
    dirPath: text("dir_path").notNull(),
    relativePath: text("relative_path").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    newestMtimeMs: bigint("newest_mtime_ms", { mode: "number" }).notNull(),
    lastSeenJobId: integer("last_seen_job_id").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("storage_leftover_folders_dir_path_idx").on(table.dirPath)]
);

export const storagePolicies = pgTable(
  "storage_policies",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    policy: text("policy").notNull(),
    source: text("source").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("storage_policies_normalized_idx").on(table.normalizedTitle)]
);

export const copySources = pgTable(
  "copy_sources",
  {
    id: serial("id").primaryKey(),
    destinationPath: text("destination_path").notNull(),
    sourcePath: text("source_path").notNull(),
    linkPath: text("link_path").notNull(),
    recordedAt: text("recorded_at").notNull()
  },
  (table) => [uniqueIndex("copy_sources_destination_idx").on(table.destinationPath)]
);

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    lockedBy: text("locked_by"),
    lockedAt: text("locked_at"),
    heartbeatAt: text("heartbeat_at"),
    leaseVersion: integer("lease_version").notNull().default(0),
    exclusive: boolean("exclusive").notNull().default(true),
    options: text("options").notNull().default("{}"),
    selectionFrozen: boolean("selection_frozen").notNull().default(false),
    cancelRequestedAt: text("cancel_requested_at"),
    progress: text("progress").notNull()
  },
  (table) => [index("jobs_terminal_retention_idx").on(table.status, table.finishedAt, table.id)]
);

export const jobSelectionItems = pgTable(
  "job_selection_items",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    mediaLinkId: integer("media_link_id").notNull(),
    selectionOrder: integer("selection_order").notNull(),
    section: text("section").notNull(),
    itemName: text("item_name").notNull(),
    relativePath: text("relative_path").notNull(),
    linkPath: text("link_path").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("job_selection_items_job_media_idx").on(table.jobId, table.mediaLinkId),
    uniqueIndex("job_selection_items_job_order_idx").on(table.jobId, table.selectionOrder),
    index("job_selection_items_job_title_idx").on(table.jobId, table.section, table.itemName)
  ]
);

export const jobResourceClaims = pgTable(
  "job_resource_claims",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceKey: text("resource_key").notNull(),
    access: text("access").notNull().default("exclusive"),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("job_resource_claims_job_resource_idx").on(table.jobId, table.resourceType, table.resourceKey),
    index("job_resource_claims_lookup_idx").on(table.resourceType, table.resourceKey, table.access),
    check("job_resource_claims_access_check", sql`${table.access} IN ('shared', 'exclusive')`)
  ]
);

export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    workerId: text("worker_id").primaryKey(),
    startedAt: text("started_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    status: text("status").notNull(),
    capacity: bigint("capacity", { mode: "number" }).notNull().default(1)
  },
  (table) => [index("worker_heartbeats_status_heartbeat_idx").on(table.status, table.heartbeatAt)]
);

export const copyOperations = pgTable(
  "copy_operations",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id").notNull(),
    mediaLinkId: integer("media_link_id").notNull(),
    linkPath: text("link_path").notNull(),
    sourcePath: text("source_path").notNull(),
    destinationPath: text("destination_path").notNull(),
    originalTargetPath: text("original_target_path").notNull(),
    originalLinkState: text("original_link_state").notNull(),
    previousCopySource: text("previous_copy_source"),
    tempPath: text("temp_path"),
    displacedPath: text("displaced_path"),
    tempIdentity: text("temp_identity"),
    destinationIdentity: text("destination_identity"),
    displacedIdentity: text("displaced_identity"),
    stage: text("stage").notNull(),
    resultStatus: text("result_status"),
    localConflictStrategy: text("local_conflict_strategy"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    errorMessage: text("error_message"),
    reconciliationResolvedAt: text("reconciliation_resolved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [uniqueIndex("copy_operations_job_link_idx").on(table.jobId, table.mediaLinkId), index("copy_operations_source_path_idx").on(table.sourcePath)]
);

export const symlinkCleanupOperations = pgTable(
  "symlink_cleanup_operations",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sourceJobId: integer("source_job_id").references(() => jobs.id, { onDelete: "set null" }),
    mediaLinkId: integer("media_link_id")
      .notNull()
      .references(() => mediaLinks.id, { onDelete: "restrict" }),
    linkPath: text("link_path").notNull(),
    expectedTargetPath: text("expected_target_path").notNull(),
    stage: text("stage").notNull(),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [
    uniqueIndex("symlink_cleanup_operations_job_link_idx").on(table.jobId, table.mediaLinkId),
    index("symlink_cleanup_operations_source_job_idx").on(table.sourceJobId, table.mediaLinkId)
  ]
);

export const orphanPurgeOperations = pgTable(
  "orphan_purge_operations",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    // The storage_files id for a file, or the storage_leftover_folders id when targetKind is "folder".
    storageFileId: integer("storage_file_id").notNull(),
    targetKind: text("target_kind").notNull().default("file"),
    rootType: text("root_type").notNull(),
    filePath: text("file_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull(),
    mode: text("mode").notNull(),
    stage: text("stage").notNull(),
    heldPath: text("held_path"),
    // JSON array of { from, to } for sidecar files moved or removed with the media file.
    extras: text("extras").notNull().default("[]"),
    purgeAfter: text("purge_after"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [
    uniqueIndex("orphan_purge_operations_job_target_idx").on(table.jobId, table.targetKind, table.storageFileId),
    index("orphan_purge_operations_held_idx").on(table.stage, table.purgeAfter)
  ]
);

export const jobEvents = pgTable("job_events", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  timestamp: text("timestamp").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  data: text("data").notNull()
});

export const scanRuns = pgTable("scan_runs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  status: text("status").notNull(),
  // Normalized scan options as JSON, kept so scan timestamps survive job history pruning.
  options: text("options").notNull().default("{}"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  errorMessage: text("error_message"),
  totalLinks: integer("total_links").notNull(),
  remoteLinks: integer("remote_links").notNull(),
  localLinks: integer("local_links").notNull(),
  brokenLinks: integer("broken_links").notNull(),
  otherLinks: integer("other_links").notNull(),
  nonMediaLinks: integer("non_media_links").notNull(),
  actionableRemoteLinks: integer("actionable_remote_links").notNull(),
  actionableLocalLinks: integer("actionable_local_links").notNull().default(0),
  assignedRemoteLinks: integer("assigned_remote_links").notNull(),
  unassignedRemoteLinks: integer("unassigned_remote_links").notNull().default(0),
  unassignedLocalLinks: integer("unassigned_local_links").notNull().default(0),
  localFiles: integer("local_files").notNull().default(0),
  remoteFiles: integer("remote_files").notNull().default(0),
  actionableRemoteFiles: integer("actionable_remote_files").notNull().default(0),
  actionableLocalFiles: integer("actionable_local_files").notNull().default(0),
  assignedRemoteFiles: integer("assigned_remote_files").notNull().default(0),
  unassignedRemoteFiles: integer("unassigned_remote_files").notNull().default(0),
  unassignedLocalFiles: integer("unassigned_local_files").notNull().default(0),
  localOrphanFiles: integer("local_orphan_files").notNull().default(0),
  remoteOrphanFiles: integer("remote_orphan_files").notNull().default(0),
  missingLinks: integer("missing_links").notNull().default(0),
  missingLocalFiles: integer("missing_local_files").notNull().default(0),
  missingRemoteFiles: integer("missing_remote_files").notNull().default(0)
});

export const auditRuns = pgTable("audit_runs", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  checked: integer("checked").notNull(),
  passed: integer("passed").notNull(),
  failed: integer("failed").notNull(),
  sourceUnknown: integer("source_unknown").notNull(),
  sourceMissing: integer("source_missing").notNull(),
  sourceCompareErrors: integer("source_compare_errors").notNull(),
  byteMismatches: integer("byte_mismatches").notNull(),
  targetValidationFailures: integer("target_validation_failures").notNull().default(0),
  errorMessage: text("error_message")
});

export const auditResults = pgTable(
  "audit_results",
  {
    id: serial("id").primaryKey(),
    auditRunId: integer("audit_run_id").notNull(),
    linkPath: text("link_path").notNull(),
    targetPath: text("target_path").notNull(),
    sourcePath: text("source_path"),
    status: text("status").notNull(),
    ffmpegStatus: text("ffmpeg_status").notNull(),
    cmpStatus: text("cmp_status").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("audit_results_run_id_idx").on(table.auditRunId, table.id)]
);

export * from "./watchSyncSchema";
export * from "./mediaServerSchema";
