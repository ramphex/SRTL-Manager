import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Archive, Check, Download, LoaderCircle, Trash2, X } from "lucide-react";
import { normalizeAdvancedSettings } from "../shared/advancedSettings";
import { api } from "./api";
import { useAccess } from "./access";
import { useDamagedFiles } from "./damagedFilesQuery";
import type { DamagedFileRow, OrphanPurgeMode } from "../shared/types";
import { StatusPill } from "./App";
import { formatBytes, formatDate, formatNumber } from "./appShared";
import { ReRequestActivity, ReRequestOption } from "./reRequest";
import { AuditDialog } from "./jobPresentation";
import type { AuditPrompt } from "./appShared";

export function DamagedFilesPanel({ rootLabel }: { rootLabel: string }) {
  const { can } = useAccess();
  const canDelete = can("library.delete");
  const canAudit = can("jobs.run");
  const damaged = useDamagedFiles();
  const rows = damaged.data ?? [];
  const hollow = rows.filter((row) => row.integrity === "hollow").length;
  const auditFailed = rows.filter((row) => row.integrity === "audit_failed").length;
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  // A deep audit decodes every frame, so it is started for these files only, never library-wide.
  const openDeepAudit = (targets: DamagedFileRow[]) => {
    if (targets.length === 0) return;
    setAuditPrompt({
      title: targets.length === 1 ? `Audit ${targets[0]!.itemName || targets[0]!.relativePath}` : `Audit ${formatNumber(targets.length)} damaged files`,
      description: targets.length === 1 ? targets[0]!.relativePath : `${formatNumber(targets.length)} files from Damaged files. A deep audit decodes every frame and gives the clearest verdict.`,
      options: { storageFileIds: targets.map((row) => row.storageFileId) }
    });
  };
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const activeJobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000, enabled: canDelete });
  const purgeRunning = (activeJobs.data ?? []).some((job) => job.type === "orphan_purge");
  const wasRunning = useRef(false);
  const refresh = () => {
    for (const key of ["damaged-files", "held-orphans", "orphan-review", "storage-file-tree", "inventory-summary", "re-requests", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  // Results land when the job finishes, not when it is queued.
  useEffect(() => {
    if (wasRunning.current && !purgeRunning) {
      for (const key of ["damaged-files", "held-orphans", "re-requests"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = purgeRunning;
  }, [purgeRunning, queryClient]);
  const remove = useMutation({
    mutationFn: (input: { mode: OrphanPurgeMode; reRequest: boolean }) => api.deleteDamagedFiles({ storageFileIds: [...selected], ...input }),
    onSuccess: () => {
      setSelected(new Set());
      setConfirming(false);
      refresh();
    }
  });
  const selectable = rows.filter((row) => !row.protectedReason);
  const selectedRows = rows.filter((row) => selected.has(row.storageFileId));
  const toggle = (id: number, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setConfirming(false);
  };
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
        {rootLabel} files that are hollow (almost nothing stored), damaged (zero-filled gaps found by sampling 24 spots in the file), or failed their last audit. Files are only sampled when a scan sees them change. A failed audit stays listed until a later audit passes or the file changes.
      </p>
      {damaged.error ? <p className="panel-message error">{damaged.error.message}</p> : null}
      {damaged.isLoading ? <p className="panel-message">Loading…</p> : null}
      {damaged.data && rows.length === 0 ? <p className="panel-message">No hollow or damaged files were found by the last scans, and no audit has failed.</p> : null}
      {rows.length > 0 ? (
        <>
          <p className="panel-message">
            {formatNumber(rows.length)} files: {formatNumber(hollow)} hollow, {formatNumber(rows.length - hollow - auditFailed)} damaged, {formatNumber(auditFailed)} failed an audit, {formatBytes(rows.reduce((total, row) => total + row.sizeBytes, 0))} in total.
          </p>
          {canDelete ? (
            <div className="orphan-toolbar damaged-files-actions">
              <button type="button" className="secondary" disabled={remove.isPending || selectable.every((row) => selected.has(row.storageFileId))} onClick={() => { setSelected(new Set(selectable.map((row) => row.storageFileId))); setConfirming(false); }}>
                Select all ({formatNumber(selectable.length)})
              </button>
              <button type="button" className="secondary" disabled={remove.isPending || selected.size === 0} onClick={() => { setSelected(new Set()); setConfirming(false); }}>
                Clear selection
              </button>
              {canAudit ? (
                <button type="button" className="secondary" disabled={selected.size === 0} onClick={() => openDeepAudit(selectedRows)}>
                  <Activity size={16} /> Audit selected ({formatNumber(selected.size)})
                </button>
              ) : null}
              <button type="button" disabled={remove.isPending || selected.size === 0} onClick={() => setConfirming(true)}>
                <Trash2 size={16} /> Delete selected ({formatNumber(selected.size)})
              </button>
            </div>
          ) : null}
          {confirming && selectedRows.length > 0 ? (
            <DamagedDeleteConfirmation rows={selectedRows} rootLabel={rootLabel} pending={remove.isPending} onCancel={() => setConfirming(false)} onConfirm={(input) => remove.mutate(input)} />
          ) : null}
          {remove.error ? <p className="panel-message error" role="alert">{remove.error.message}</p> : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {canDelete ? <th scope="col" aria-label="Select" /> : null}
                  <th scope="col">Title</th>
                  <th scope="col">Status</th>
                  <th scope="col">Size</th>
                  <th scope="col">Stored</th>
                  <th scope="col">Zero samples</th>
                  <th scope="col">In library</th>
                  <th scope="col">Remote copy</th>
                  <th scope="col">Checked</th>
                  <th scope="col">Last audit</th>
                  {canAudit ? <th scope="col" aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DamagedFileTableRow
                    key={row.storageFileId}
                    row={row}
                    selection={canDelete ? { checked: selected.has(row.storageFileId), disabled: remove.isPending, onChange: (checked) => toggle(row.storageFileId, checked) } : null}
                    onAudit={canAudit ? () => openDeepAudit([row]) : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {remove.data ? (
        <p className="panel-message success" role="status">
          {purgeRunning ? "Delete job" : "Finished delete job"} <Link to="/logs" search={{ job: remove.data.jobId }}>#{remove.data.jobId}</Link>. Held files can be restored from <Link to="/library" search={{ view: "local-orphans" }}>{rootLabel} orphans</Link>.
        </p>
      ) : null}
      {canDelete ? <ReRequestActivity /> : null}
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
    </section>
  );
}

function DamagedDeleteConfirmation({ rows, rootLabel, pending, onCancel, onConfirm }: { rows: DamagedFileRow[]; rootLabel: string; pending: boolean; onCancel: () => void; onConfirm: (input: { mode: OrphanPurgeMode; reRequest: boolean }) => void }) {
  const advanced = useQuery({ queryKey: ["advanced-settings"], queryFn: api.getAdvancedSettings });
  const holdDays = normalizeAdvancedSettings(advanced.data).cleanup.holdDays;
  const [mode, setMode] = useState<OrphanPurgeMode>("hold");
  const [reRequest, setReRequest] = useState(false);
  const count = rows.length;
  const bytes = rows.reduce((total, row) => total + row.sizeBytes, 0);
  const files = `${formatNumber(count)} ${count === 1 ? "file" : "files"}`;
  const linked = rows.filter((row) => row.linked).length;
  const withRemote = rows.filter((row) => row.remoteCopyExists).length;
  return (
    <div className="orphan-confirmation damaged-confirmation" role="group" aria-label="Confirm damaged file delete">
      <div className="segmented" role="group" aria-label="Delete mode">
        <button type="button" className={mode === "hold" ? "selected" : ""} aria-pressed={mode === "hold"} onClick={() => setMode("hold")}>
          <Archive size={14} /> Hold {holdDays} days
        </button>
        <button type="button" className={mode === "delete" ? "selected" : ""} aria-pressed={mode === "delete"} onClick={() => setMode("delete")}>
          <Trash2 size={14} /> Delete now
        </button>
      </div>
      <p>
        {mode === "hold"
          ? `Move ${files} (${formatBytes(bytes)}) on ${rootLabel} to the holding area? They can be restored for ${holdDays} days, then they are permanently deleted.`
          : `Permanently delete ${files} (${formatBytes(bytes)}) on ${rootLabel}? This cannot be undone.`}
        {linked > 0 ? ` ${formatNumber(linked)} ${linked === 1 ? "is" : "are"} in the library: ${linked === 1 ? "its symlink is" : "their symlinks are"} removed too, so ${linked === 1 ? "that title" : "those titles"} will show as missing until replaced.` : ""}
        {withRemote > 0 ? ` ${formatNumber(withRemote)} ${withRemote === 1 ? "has" : "have"} a remote copy, which is not touched and not linked automatically.` : ""}
      </p>
      <ReRequestOption storageFileIds={rows.map((row) => row.storageFileId)} checked={reRequest} onChange={setReRequest} disabled={pending} />
      <div className="orphan-toolbar">
        <button type="button" disabled={pending} onClick={() => onConfirm({ mode, reRequest })}>
          {pending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} {mode === "hold" ? "Move to holding area" : "Delete permanently"}
        </button>
        <button type="button" className="secondary" disabled={pending} onClick={onCancel}>
          <X size={16} /> Cancel
        </button>
      </div>
    </div>
  );
}

function DamagedFileTableRow({
  row,
  selection,
  onAudit
}: {
  row: DamagedFileRow;
  selection: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void } | null;
  onAudit: (() => void) | null;
}) {
  return (
    <tr>
      {selection ? (
        <td>
          <input type="checkbox" aria-label={`Select ${row.relativePath}`} checked={selection.checked} disabled={selection.disabled || Boolean(row.protectedReason)} onChange={(event) => selection.onChange(event.target.checked)} />
        </td>
      ) : null}
      <td>
        <strong>{row.itemName || row.relativePath}</strong>
        <span className="orphan-path">{row.relativePath}</span>
        {selection && row.protectedReason ? <span className="orphan-protected">Protected: {row.protectedReason}</span> : null}
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
      <td>
        {row.audit ? (
          <span className="damaged-audit" title={row.audit.message ?? undefined}>
            {row.audit.mode === "deep" ? "Deep" : "Fast"} {row.audit.status === "fail" ? "failed" : row.audit.status === "pass" ? "passed" : row.audit.status.replace("_", " ")}
            <small>{formatDate(row.audit.checkedAt)}</small>
          </span>
        ) : (
          "-"
        )}
      </td>
      {onAudit ? (
        <td>
          <button type="button" className="table-action-button secondary" onClick={onAudit} title="Start a fast or deep audit of this file">
            <Activity size={14} /> <span>Audit</span>
          </button>
        </td>
      ) : null}
    </tr>
  );
}

export function DamageIntegrityPill({ integrity }: { integrity: "ok" | "hollow" | "partial_hollow" | "unknown" | "audit_failed" }) {
  if (integrity === "audit_failed") return <span title="The last audit of this file failed; open the audit history for the reason"><StatusPill value="Failed audit" /></span>;
  if (integrity === "hollow") return <span title="Almost none of this file is stored on disk; it may be a placeholder or an interrupted copy"><StatusPill value="Hollow" /></span>;
  if (integrity === "partial_hollow") return <span title="Sampling found zero-filled gaps inside this file"><StatusPill value="Damaged" /></span>;
  return null;
}
