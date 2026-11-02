import { sql } from "drizzle-orm";
import { integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

// Plex and Jellyfin connections shared by watch sync and the other features that read media servers.
// Ids are the short ids watch sync already used, so pairs, users, and the item index keep pointing at them.
export const mediaServers = pgTable("media_servers", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  // A Plex owner token or a Jellyfin API key. Never sent to the browser.
  token: text("token").notNull().default(""),
  prefixMappings: text("prefix_mappings").notNull().default("[]"),
  machineIdentifier: text("machine_identifier"),
  accountName: text("account_name"),
  accountId: text("account_id"),
  version: text("version"),
  lastCheckedAt: text("last_checked_at"),
  lastError: text("last_error"),
  // A Plex PIN sign-in waiting for approval at plex.tv, as JSON.
  pendingPin: text("pending_pin"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => [uniqueIndex("media_servers_name_idx").on(sql`lower(${table.name})`)]);
