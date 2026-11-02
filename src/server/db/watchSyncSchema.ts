import { bigint, boolean, index, integer, pgTable, primaryKey, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

// Users each Plex or Jellyfin server knows. Plex access tokens are per user and never leave the server.
export const watchSyncUsers = pgTable("watch_sync_users", {
  serverId: text("server_id").notNull(),
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  username: text("username"),
  kind: text("kind").notNull(),
  // The account id the Plex server's own history uses for this user.
  accountId: text("account_id"),
  accessToken: text("access_token"),
  available: boolean("available").notNull().default(true),
  note: text("note"),
  updatedAt: text("updated_at").notNull()
}, (table) => [primaryKey({ columns: [table.serverId, table.externalId] })]);

export const watchSyncPairs = pgTable("watch_sync_pairs", {
  id: serial("id").primaryKey(),
  plexServerId: text("plex_server_id").notNull(),
  plexUserId: text("plex_user_id").notNull(),
  jellyfinServerId: text("jellyfin_server_id").notNull(),
  jellyfinUserId: text("jellyfin_user_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  paused: boolean("paused").notNull().default(false),
  direction: text("direction").notNull().default("both"),
  // Null follows the global setting.
  syncWatched: boolean("sync_watched"),
  syncPosition: boolean("sync_position"),
  // Nothing is written for a pair until its preview is approved.
  approvedAt: text("approved_at"),
  preview: text("preview"),
  plexCursor: text("plex_cursor"),
  jellyfinCursor: text("jellyfin_cursor"),
  recheckCursor: text("recheck_cursor"),
  lastSyncAt: text("last_sync_at"),
  lastFullSyncAt: text("last_full_sync_at"),
  lastError: text("last_error"),
  errorCount: integer("error_count").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("watch_sync_pairs_users_idx").on(table.plexServerId, table.plexUserId, table.jellyfinServerId, table.jellyfinUserId)]);

export const watchSyncItems = pgTable("watch_sync_items", {
  serverId: text("server_id").notNull(),
  linkPath: text("link_path").notNull(),
  itemId: text("item_id").notNull(),
  seenAt: text("seen_at").notNull()
}, (table) => [primaryKey({ columns: [table.serverId, table.linkPath] }), index("watch_sync_items_item_idx").on(table.serverId, table.itemId)]);

export const watchSyncState = pgTable("watch_sync_state", {
  pairId: integer("pair_id").notNull().references(() => watchSyncPairs.id, { onDelete: "cascade" }),
  linkPath: text("link_path").notNull(),
  plexWatched: boolean("plex_watched"),
  plexPositionMs: bigint("plex_position_ms", { mode: "number" }),
  plexAt: text("plex_at"),
  jellyfinWatched: boolean("jellyfin_watched"),
  jellyfinPositionMs: bigint("jellyfin_position_ms", { mode: "number" }),
  jellyfinAt: text("jellyfin_at"),
  syncedAt: text("synced_at").notNull()
}, (table) => [primaryKey({ columns: [table.pairId, table.linkPath] })]);

export const watchSyncActivity = pgTable("watch_sync_activity", {
  id: serial("id").primaryKey(),
  pairId: integer("pair_id").references(() => watchSyncPairs.id, { onDelete: "cascade" }),
  at: text("at").notNull(),
  level: text("level").notNull(),
  direction: text("direction"),
  action: text("action"),
  linkPath: text("link_path"),
  message: text("message").notNull(),
  jobId: integer("job_id")
}, (table) => [index("watch_sync_activity_pair_idx").on(table.pairId, table.id), index("watch_sync_activity_at_idx").on(table.at)]);

export const watchSyncCursors = pgTable("watch_sync_cursors", {
  scope: text("scope").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});
