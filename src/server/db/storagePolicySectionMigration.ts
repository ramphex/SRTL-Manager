import type { PoolClient } from "pg";
import { planPolicyPlacement, type PlaceablePolicyRow } from "../lib/storagePolicyPlacement";

async function hasColumns(client: PoolClient, table: string, columns: string[]): Promise<boolean> {
  const found = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const names = new Set(found.rows.map((row) => row.column_name));
  return columns.every((column) => names.has(column));
}

/**
 * Storage policies move from one row per title to one row per folder (section) and title. Each existing title-wide
 * row becomes a row in every folder where that title has links, current or missing, with the same policy, source and
 * timestamp, so nothing a scan, copy or integration does changes. A title with no links in any folder keeps its row
 * with an empty section; the first scan that finds the title places it in those folders. Running it again is a no-op.
 */
export async function applyStoragePolicySectionMigration(client: PoolClient): Promise<void> {
  if (!(await hasColumns(client, "storage_policies", ["id", "policy"]))) return;
  await client.query(`ALTER TABLE storage_policies ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT ''`);
  if (!(await hasColumns(client, "storage_policies", ["title", "normalized_title", "source", "updated_at"]))) return;
  // The old one-row-per-title constraints, from the initial DDL and the Drizzle schema.
  await client.query(`ALTER TABLE storage_policies DROP CONSTRAINT IF EXISTS storage_policies_normalized_title_key`);
  await client.query(`DROP INDEX IF EXISTS storage_policies_normalized_idx`);

  if (await hasColumns(client, "media_links", ["section", "item_name"])) {
    const policies = (
      await client.query<PlaceablePolicyRow>(`
        SELECT id, section, title, normalized_title AS "normalizedTitle", policy, source, updated_at AS "updatedAt"
        FROM storage_policies
        FOR UPDATE
      `)
    ).rows;
    const linkTitles = (await client.query<{ section: string; itemName: string }>(`SELECT DISTINCT section, item_name AS "itemName" FROM media_links`)).rows;
    const plan = planPolicyPlacement(policies, linkTitles);
    for (let offset = 0; offset < plan.inserts.length; offset += 500) {
      const batch = plan.inserts.slice(offset, offset + 500);
      await client.query(
        `INSERT INTO storage_policies (section, title, normalized_title, policy, source, updated_at)
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(section text, title text, "normalizedTitle" text, policy text, source text, "updatedAt" text)`,
        [JSON.stringify(batch)]
      );
    }
    if (plan.deleteIds.length > 0) {
      await client.query(`DELETE FROM storage_policies WHERE id = ANY($1::int[])`, [plan.deleteIds]);
    }
  }

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS storage_policies_section_title_idx ON storage_policies (section, normalized_title)`);
  await client.query(`CREATE INDEX IF NOT EXISTS storage_policies_normalized_title_idx ON storage_policies (normalized_title)`);
}
