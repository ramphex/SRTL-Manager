import { sql } from "drizzle-orm";
import { dbAll, type Db } from "../db/database";
import type { DamagedFileRow } from "../../shared/types";
import { effectiveIntegrity, hollowAllocationRatio, hollowMinimumBytes, zeroSampleCount } from "./mediaIntegrity";

type RawDamagedRow = {
  id: number;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  sizeBytes: number | string;
  allocatedBytes: number | string | null;
  integrity: string | null;
  zeroSamples: number | null;
  checkedAt: string | null;
  linkCount: number | string;
  remoteCopyExists: boolean;
};

// Local files only: block counts on the remote mount are meaningless, so its files are never classified.
export async function listDamagedFiles(db: Db): Promise<DamagedFileRow[]> {
  const rows = await dbAll<RawDamagedRow>(db, sql`
    select
      sf.id,
      sf.section,
      sf.item_name as "itemName",
      sf.relative_path as "relativePath",
      sf.file_path as "filePath",
      sf.size_bytes as "sizeBytes",
      sf.allocated_bytes as "allocatedBytes",
      sf.integrity,
      sf.integrity_zero_samples as "zeroSamples",
      sf.integrity_checked_at as "checkedAt",
      (select count(*) from media_links ml where ml.missing_since is null and ml.resolved_storage_file_id = sf.id) as "linkCount",
      exists (
        select 1 from storage_files remote
        where remote.root_type = 'remote' and remote.missing_since is null and remote.relative_path = sf.relative_path
      ) as "remoteCopyExists"
    from storage_files sf
    where sf.root_type = 'local' and sf.missing_since is null
      and (
        sf.integrity in ('hollow', 'partial_hollow')
        or (sf.size_bytes >= ${hollowMinimumBytes} and sf.allocated_bytes > 0 and sf.allocated_bytes < sf.size_bytes * ${hollowAllocationRatio}::float8)
      )
    order by lower(sf.item_name), lower(sf.relative_path)
  `);
  return rows.flatMap((row) => {
    const sizeBytes = Number(row.sizeBytes);
    const allocatedBytes = row.allocatedBytes == null ? null : Number(row.allocatedBytes);
    const integrity = effectiveIntegrity(sizeBytes, allocatedBytes, row.integrity);
    if (integrity !== "hollow" && integrity !== "partial_hollow") return [];
    return [
      {
        storageFileId: row.id,
        section: row.section,
        itemName: row.itemName,
        relativePath: row.relativePath,
        filePath: row.filePath,
        sizeBytes,
        allocatedBytes,
        storedPercent: allocatedBytes == null || sizeBytes <= 0 ? null : Math.round(Math.min(100, (allocatedBytes / sizeBytes) * 100) * 10) / 10,
        integrity,
        zeroSamples: row.zeroSamples,
        zeroSamplesTotal: zeroSampleCount,
        checkedAt: row.checkedAt,
        linked: Number(row.linkCount) > 0,
        remoteCopyExists: Boolean(row.remoteCopyExists)
      }
    ];
  });
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  let text = String(value);
  // Spreadsheet apps run cells that start with these characters as formulas, and file names are not trusted.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function damagedFilesCsv(rows: DamagedFileRow[]): string {
  const header = ["Title", "Section", "Verdict", "Path", "Size bytes", "Stored bytes", "Stored %", "Zero samples", "Samples", "Checked at", "Linked in library", "Remote copy exists"];
  const lines = rows.map((row) =>
    [
      row.itemName,
      row.section,
      row.integrity === "hollow" ? "Hollow" : "Damaged",
      row.filePath,
      row.sizeBytes,
      row.allocatedBytes,
      row.storedPercent,
      row.zeroSamples,
      row.zeroSamplesTotal,
      row.checkedAt,
      row.linked ? "yes" : "no",
      row.remoteCopyExists ? "yes" : "no"
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}
