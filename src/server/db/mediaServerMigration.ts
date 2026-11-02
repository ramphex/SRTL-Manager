import type { PoolClient } from "pg";

interface LegacyServer {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  url?: unknown;
  token?: unknown;
  prefixMappings?: unknown;
  machineIdentifier?: unknown;
  accountName?: unknown;
  accountId?: unknown;
}

const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;

function parse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

// Migration 24: moves the Plex and Jellyfin servers out of the watch sync setting into media_servers, a table every
// feature can read. Each server keeps its id, token, prefix mappings, and status, so existing pairs, users, the item
// index, snapshots, and activity keep working without signing in again.
export async function applyMediaServerMigration(client: PoolClient, timestamp: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS media_servers (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('plex', 'jellyfin')), name TEXT NOT NULL, url TEXT NOT NULL,
    token TEXT NOT NULL DEFAULT '', prefix_mappings TEXT NOT NULL DEFAULT '[]',
    machine_identifier TEXT, account_name TEXT, account_id TEXT, version TEXT,
    last_checked_at TEXT, last_error TEXT, pending_pin TEXT, position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS media_servers_name_idx ON media_servers (lower(name))`);

  const exists = async (table: string) => Boolean((await client.query<{ name: string | null }>(`SELECT to_regclass($1)::text AS name`, [`public.${table}`])).rows[0]?.name);
  if (!await exists("app_settings")) return;
  const setting = (await client.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'watchSync'`)).rows[0];
  const watchSync = parse(setting?.value);
  if (!watchSync || typeof watchSync !== "object" || Array.isArray(watchSync)) return;
  const { servers, clientIdentifier, ...rest } = watchSync as { servers?: unknown; clientIdentifier?: unknown };
  const hasStatusTable = await exists("watch_sync_cursors");

  if (Array.isArray(servers)) {
    const usedNames = new Set((await client.query<{ name: string }>(`SELECT lower(name) AS name FROM media_servers`)).rows.map((row) => row.name));
    for (const [position, entry] of (servers as LegacyServer[]).entries()) {
      const id = text(entry?.id);
      const kind = entry?.kind === "plex" || entry?.kind === "jellyfin" ? entry.kind : null;
      const url = text(entry?.url);
      if (!id || !kind || !url) continue;
      // Names were unique already; a clash only gains the id so the migration never fails on it.
      let name = text(entry.name)?.trim() || id;
      if (usedNames.has(name.toLowerCase())) name = `${name} (${id})`;
      usedNames.add(name.toLowerCase());
      type LegacyStatus = { lastCheckedAt?: unknown; lastError?: unknown } | null;
      const status: LegacyStatus = hasStatusTable
        ? parse((await client.query<{ value: string }>(`SELECT value FROM watch_sync_cursors WHERE scope = $1`, [`server-status:${id}`])).rows[0]?.value) as LegacyStatus
        : null;
      await client.query(
        `INSERT INTO media_servers (id, kind, name, url, token, prefix_mappings, machine_identifier, account_name, account_id, last_checked_at, last_error, position, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) ON CONFLICT (id) DO NOTHING`,
        [id, kind, name, url, typeof entry.token === "string" ? entry.token : "", JSON.stringify(Array.isArray(entry.prefixMappings) ? entry.prefixMappings : []),
          text(entry.machineIdentifier), text(entry.accountName), text(entry.accountId), text(status?.lastCheckedAt), text(status?.lastError), position, timestamp]
      );
    }
  }

  // Plex and Jellyfin know SRTL by this id, so it moves with the servers instead of being created again.
  if (typeof clientIdentifier === "string" && clientIdentifier) {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('mediaServers', $1, $2) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify({ clientIdentifier }), timestamp]
    );
  }
  await client.query(`UPDATE app_settings SET value = $1, updated_at = $2 WHERE key = 'watchSync'`, [JSON.stringify(rest), timestamp]);
  // Status now lives on the server rows; a Plex sign-in that was waiting is simply started again.
  if (hasStatusTable) await client.query(`DELETE FROM watch_sync_cursors WHERE scope LIKE 'server-status:%' OR scope LIKE 'plex-pin:%'`);
}
