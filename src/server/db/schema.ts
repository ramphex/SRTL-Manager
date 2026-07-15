import { bigint, boolean, integer, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

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
  validationStatus: text("validation_status").notNull(),
  message: text("message").notNull(),
  appliedAt: text("applied_at"),
  rolledBackAt: text("rolled_back_at")
});

export const adminUsers = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull()
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
});

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
  (table) => [uniqueIndex("media_links_link_path_idx").on(table.linkPath)]
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
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    lastChangedAt: text("last_changed_at").notNull(),
    missingSince: text("missing_since"),
    lastSeenJobId: integer("last_seen_job_id").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("storage_files_file_path_idx").on(table.filePath)]
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

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  lockedBy: text("locked_by"),
  lockedAt: text("locked_at"),
  heartbeatAt: text("heartbeat_at"),
  cancelRequestedAt: text("cancel_requested_at"),
  progress: text("progress").notNull()
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: text("started_at").notNull(),
  heartbeatAt: text("heartbeat_at").notNull(),
  status: text("status").notNull()
});

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
    stage: text("stage").notNull(),
    resultStatus: text("result_status"),
    localConflictStrategy: text("local_conflict_strategy"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [uniqueIndex("copy_operations_job_link_idx").on(table.jobId, table.mediaLinkId)]
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

export const auditResults = pgTable("audit_results", {
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
});
