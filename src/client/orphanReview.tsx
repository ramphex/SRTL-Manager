import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, LoaderCircle, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import type { OrphanCategory, OrphanPurgeMode, OrphanReviewItem, StorageRootType } from "../shared/types";
import { api } from "./api";
import { InfoTooltip, Panel } from "./App";
import { formatBytes, formatDate, formatNumber } from "./appShared";

const pageSize = 50;

const orphanCategoryLabels: Record<OrphanCategory, { label: string; detail: string }> = {
  superseded: { label: "Older or duplicate versions", detail: "Another file of the same movie or episode is linked, usually after an upgrade." },
  copy_leftover: { label: "Copy leftovers", detail: "SRTL already copied this file to the other storage location." },
  not_in_library: { label: "Not in library", detail: "No symlink exists for this title or episode anymore." },
  srtl_artifact: { label: "SRTL leftovers", detail: "Temporary, kept, or backup files that SRTL created." },
  unlinked: { label: "Unlinked", detail: "No symlink points to this file. Remote files often belong to the provider's wider library." }
};

function fileName(item: OrphanReviewItem): string {
  return item.relativePath.split("/").at(-1) ?? item.relativePath;
}

export function OrphanReviewPanel({ rootType, rootLabel }: { rootType: StorageRootType; rootLabel: string }) {
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: ["orphan-review", rootType], queryFn: () => api.orphanReview(rootType) });
  const held = useQuery({ queryKey: ["held-orphans"], queryFn: api.heldOrphans });
  const activeJobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const purgeRunning = (activeJobs.data ?? []).some((job) => job.type === "orphan_purge");
  const wasRunning = useRef(false);
  const [category, setCategory] = useState<OrphanCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<OrphanPurgeMode>(rootType === "local" ? "hold" : "delete");
  const [confirming, setConfirming] = useState(false);
  const [selectedHeld, setSelectedHeld] = useState<Set<number>>(new Set());
  const refresh = () => {
    for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const purge = useMutation({
    mutationFn: () => api.purgeOrphans({ rootType, storageFileIds: [...selected], mode }),
    onSuccess: () => {
      setSelected(new Set());
      setConfirming(false);
      refresh();
    }
  });
  const restore = useMutation({
    mutationFn: () => api.restoreHeldOrphans([...selectedHeld]),
    onSuccess: () => {
      setSelectedHeld(new Set());
      refresh();
    }
  });

  const items = useMemo(() => review.data?.items ?? [], [review.data]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => (category === "all" || item.category === category) && (!needle || item.relativePath.toLowerCase().includes(needle)));
  }, [items, category, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selectedItems = items.filter((item) => selected.has(item.storageFileId));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.sizeBytes, 0);
  const heldHere = (held.data ?? []).filter((file) => file.rootType === rootType);
  const stale = Boolean(review.data?.staleWarning);
  const busy = purge.isPending || restore.isPending;
  // Results land when the purge job finishes, not when it is queued, so refresh once it stops running.
  useEffect(() => {
    if (wasRunning.current && !purgeRunning) {
      for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = purgeRunning;
  }, [purgeRunning, queryClient]);
  const files = (count: number) => `${formatNumber(count)} ${count === 1 ? "file" : "files"}`;

  const toggle = (id: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectPurgeable = (list: OrphanReviewItem[]) => {
    setSelected((current) => new Set([...current, ...list.filter((item) => !item.protectedReason).map((item) => item.storageFileId)]));
    setConfirming(false);
  };

  return (
    <Panel title={`Review ${rootLabel} orphans`} icon={<Trash2 size={18} />}>
      <div className="orphan-review">
        {review.isLoading ? <p className="panel-message">Loading orphans...</p> : null}
        {review.error ? <p className="panel-message error">{review.error.message}</p> : null}
        {review.data?.staleWarning ? (
          <p className="panel-message action-error" role="alert">
            <TriangleAlert size={14} /> {review.data.staleWarning}
          </p>
        ) : null}
        {review.data ? (
          <>
            <div className="orphan-categories" role="group" aria-label="Orphan categories">
              <button type="button" className={category === "all" ? "orphan-category selected" : "orphan-category"} aria-pressed={category === "all"} onClick={() => { setCategory("all"); setPage(0); }}>
                <strong>All orphans</strong>
                <small>{files(items.length)}, {formatBytes(items.reduce((total, item) => total + item.sizeBytes, 0))}</small>
              </button>
              {review.data.summary.map((entry) => (
                <button key={entry.category} type="button" className={category === entry.category ? "orphan-category selected" : "orphan-category"} aria-pressed={category === entry.category} title={orphanCategoryLabels[entry.category].detail} onClick={() => { setCategory(entry.category); setPage(0); }}>
                  <strong>{orphanCategoryLabels[entry.category].label}</strong>
                  <small>{files(entry.count)}, {formatBytes(entry.sizeBytes)}</small>
                </button>
              ))}
            </div>
            {category !== "all" ? <p className="muted">{orphanCategoryLabels[category].detail}</p> : null}
            <div className="orphan-toolbar">
              <input type="search" aria-label="Search orphan files" placeholder="Search files" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
              <button type="button" className="secondary" disabled={busy || stale || !filtered.some((item) => !item.protectedReason && !selected.has(item.storageFileId))} onClick={() => selectPurgeable(filtered)}>
                Select all {category === "all" ? "" : orphanCategoryLabels[category].label.toLowerCase()} ({formatNumber(filtered.filter((item) => !item.protectedReason).length)})
              </button>
              <button type="button" className="secondary" disabled={busy || selected.size === 0} onClick={() => { setSelected(new Set()); setConfirming(false); }}>
                Clear selection
              </button>
            </div>
            <div className="orphan-table-scroll" tabIndex={0} aria-label="Orphan files">
              <table>
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>File</th>
                    <th>Category</th>
                    <th>Size</th>
                    <th>Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => (
                    <tr key={item.storageFileId}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${fileName(item)}`} checked={selected.has(item.storageFileId)} disabled={busy || stale || Boolean(item.protectedReason)} onChange={(event) => { toggle(item.storageFileId, event.target.checked); setConfirming(false); }} />
                      </td>
                      <td>
                        <strong>{fileName(item)}</strong>
                        <span className="orphan-path">{item.relativePath}</span>
                        {item.protectedReason ? <span className="orphan-protected">Protected: {item.protectedReason}</span> : null}
                      </td>
                      <td>{orphanCategoryLabels[item.category].label}</td>
                      <td className="orphan-nowrap">{formatBytes(item.sizeBytes)}</td>
                      <td className="orphan-nowrap">{formatDate(new Date(item.mtimeMs).toISOString())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 ? <p className="muted">{items.length ? "No matching orphans." : "No orphans on this storage."}</p> : null}
            <div className="orphan-toolbar orphan-pagination">
              <span>
                {formatNumber(selected.size)} selected ({formatBytes(selectedBytes)})
              </span>
              <span>
                Page {currentPage + 1} of {pageCount}
              </span>
              <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                Previous
              </button>
              <button type="button" className="secondary" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>
                Next
              </button>
            </div>
            <div className="orphan-purge-actions">
              <div className="segmented" role="group" aria-label="Purge mode">
                <button type="button" className={mode === "hold" ? "selected" : ""} aria-pressed={mode === "hold"} onClick={() => { setMode("hold"); setConfirming(false); }}>
                  <Archive size={14} /> Hold {review.data.holdDays} days
                </button>
                <button type="button" className={mode === "delete" ? "selected" : ""} aria-pressed={mode === "delete"} onClick={() => { setMode("delete"); setConfirming(false); }}>
                  <Trash2 size={14} /> Delete now
                </button>
              </div>
              <InfoTooltip label="About purge modes">
                Hold moves files into a hidden .srtl-purged folder on the same storage, where they can be restored until they are permanently deleted after the holding period. Delete now removes them immediately with no undo. {rootType === "remote" ? "The remote mount may not support holding; files it refuses are reported and left in place." : ""} Every file is rechecked right before it is touched: still unlinked, unchanged, not part of a copy, and older than 24 hours. Subtitles, artwork, and empty folders are cleaned up with the last video in a folder.
              </InfoTooltip>
              <button type="button" disabled={busy || stale || selected.size === 0} onClick={() => setConfirming(true)}>
                <Trash2 size={16} /> Purge selected
              </button>
            </div>
            {confirming ? (
              <div className="orphan-confirmation" role="group" aria-label="Confirm orphan purge">
                <p>
                  {mode === "hold"
                    ? `Move ${files(selected.size)} (${formatBytes(selectedBytes)}) on ${rootLabel} to the holding area? They can be restored for ${review.data.holdDays} days, then they are permanently deleted.`
                    : `Permanently delete ${files(selected.size)} (${formatBytes(selectedBytes)}) on ${rootLabel}? This cannot be undone.`}
                </p>
                <div className="orphan-toolbar">
                  <button type="button" disabled={busy} onClick={() => purge.mutate()}>
                    {purge.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} {mode === "hold" ? "Move to holding area" : "Delete permanently"}
                  </button>
                  <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                    <X size={16} /> Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {purge.data ? (
              <p className="panel-message success">
                {purgeRunning ? `Orphan purge job #${purge.data.jobId} is running. This list refreshes when it finishes.` : `Orphan purge job #${purge.data.jobId} finished. See Recent Jobs for details.`}
              </p>
            ) : null}
            {purge.error ? <p className="panel-message error" role="alert">{purge.error.message}</p> : null}
          </>
        ) : null}

        <section className="orphan-held" aria-labelledby={`held-${rootType}-heading`}>
          <h3 id={`held-${rootType}-heading`}>Held files on {rootLabel}</h3>
          {heldHere.length === 0 ? (
            <p className="muted">No files are waiting in the holding area.</p>
          ) : (
            <>
              <div className="orphan-table-scroll" tabIndex={0} aria-label="Held orphan files">
                <table>
                  <thead>
                    <tr>
                      <th aria-label="Select" />
                      <th>Original location</th>
                      <th>Size</th>
                      <th>Deleted on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heldHere.map((file) => (
                      <tr key={file.operationId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select held ${file.filePath}`}
                            checked={selectedHeld.has(file.operationId)}
                            disabled={busy}
                            onChange={(event) =>
                              setSelectedHeld((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(file.operationId);
                                else next.delete(file.operationId);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="orphan-path-cell">{file.filePath}</td>
                        <td className="orphan-nowrap">{formatBytes(file.sizeBytes)}</td>
                        <td className="orphan-nowrap">{formatDate(file.purgeAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="orphan-toolbar">
                <button type="button" className="secondary" disabled={busy || selectedHeld.size === 0} onClick={() => restore.mutate()}>
                  {restore.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <RotateCcw size={16} />} Restore selected
                </button>
              </div>
            </>
          )}
          {restore.data && restore.data.errors.length === 0 ? <p className="panel-message success">Restored {files(restore.data.restored)}. Rescan to relink them if needed.</p> : null}
          {restore.data?.errors.length ? <p className="panel-message error" role="alert">{restore.data.errors.join("; ")}</p> : null}
          {restore.error ? <p className="panel-message error" role="alert">{restore.error.message}</p> : null}
        </section>
      </div>
    </Panel>
  );
}
