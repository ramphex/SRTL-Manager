import { Download } from "lucide-react";
import { api } from "./api";
import { useDamagedFiles } from "./damagedFilesQuery";
import type { DamagedFileRow } from "../shared/types";
import { StatusPill } from "./App";
import { formatBytes, formatDate, formatNumber } from "./appShared";

export function DamagedFilesPanel({ rootLabel }: { rootLabel: string }) {
  const damaged = useDamagedFiles();
  const rows = damaged.data ?? [];
  const hollow = rows.filter((row) => row.integrity === "hollow").length;
  return (
    <section className="panel damaged-files">
      <div className="panel-title">
        <h2>Damaged files</h2>
        <div className="panel-title-actions">
          <a className="ghost-button" href={api.damagedFilesCsvUrl} download aria-disabled={rows.length === 0}>
            <Download size={15} />
            Export CSV
          </a>
        </div>
      </div>
      <p className="panel-message">
        {rootLabel} files that are hollow (almost nothing stored) or damaged (zero-filled gaps found by sampling 24 spots in the file). Files are only sampled when a scan sees them change.
      </p>
      {damaged.error ? <p className="panel-message error">{damaged.error.message}</p> : null}
      {damaged.isLoading ? <p className="panel-message">Loading…</p> : null}
      {damaged.data && rows.length === 0 ? <p className="panel-message">No hollow or damaged files were found by the last scans.</p> : null}
      {rows.length > 0 ? (
        <>
          <p className="panel-message">
            {formatNumber(rows.length)} files: {formatNumber(hollow)} hollow, {formatNumber(rows.length - hollow)} damaged, {formatBytes(rows.reduce((total, row) => total + row.sizeBytes, 0))} in total.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Size</th>
                  <th scope="col">Stored</th>
                  <th scope="col">Zero samples</th>
                  <th scope="col">In library</th>
                  <th scope="col">Remote copy</th>
                  <th scope="col">Checked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DamagedFileTableRow key={row.storageFileId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function DamagedFileTableRow({ row }: { row: DamagedFileRow }) {
  return (
    <tr>
      <td>
        <strong>{row.itemName || row.relativePath}</strong>
        <span className="orphan-path">{row.relativePath}</span>
      </td>
      <td>
        <DamageIntegrityPill integrity={row.integrity} />
      </td>
      <td className="orphan-nowrap">{formatBytes(row.sizeBytes)}</td>
      <td className="orphan-nowrap">{row.storedPercent == null ? "-" : `${row.storedPercent}%`}</td>
      <td className="orphan-nowrap">{row.zeroSamples == null ? "-" : `${row.zeroSamples} / ${row.zeroSamplesTotal}`}</td>
      <td>{row.linked ? "Linked" : "Orphan"}</td>
      <td>{row.remoteCopyExists ? "Yes" : "No"}</td>
      <td className="orphan-nowrap">{row.checkedAt ? formatDate(row.checkedAt) : "-"}</td>
    </tr>
  );
}

export function DamageIntegrityPill({ integrity }: { integrity: "ok" | "hollow" | "partial_hollow" | "unknown" }) {
  if (integrity === "hollow") return <span title="Almost none of this file is stored on disk; it may be a placeholder or an interrupted copy"><StatusPill value="Hollow" /></span>;
  if (integrity === "partial_hollow") return <span title="Sampling found zero-filled gaps inside this file"><StatusPill value="Damaged" /></span>;
  return null;
}
