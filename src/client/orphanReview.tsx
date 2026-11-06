import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Archive, Check, LoaderCircle, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import type { OrphanCategory, OrphanPurgeMode, OrphanReview, OrphanReviewItem, StorageRootType } from "../shared/types";
import { api } from "./api";
import { InfoTooltip, Panel } from "./App";
import { formatBytes, formatDate, formatNumber, useModalLifecycle } from "./appShared";
import { purgeBatches, purgeConfirmationPhrase, purgeNeedsPhrase, planPurgeAll } from "./orphanPurgePlan";
import { ReRequestActivity, ReRequestOption } from "./reRequest";

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

export function OrphanReviewPanel({ rootType, rootLabel, autoOpenPurgeAll = false }: { rootType: StorageRootType; rootLabel: string; autoOpenPurgeAll?: boolean }) {
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
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<OrphanPurgeMode>(rootType === "local" ? "hold" : "delete");
  const [confirming, setConfirming] = useState(false);
  const [purgeAllOpen, setPurgeAllOpen] = useState(autoOpenPurgeAll);
  const [selectedHeld, setSelectedHeld] = useState<Set<number>>(new Set());
  const refresh = () => {
    for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary", "re-requests", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const purge = useMutation({
    mutationFn: (reRequest: boolean) => api.purgeOrphans({ rootType, storageFileIds: [...selected], folderIds: [...selectedFolders], mode, reRequest }),
    onSuccess: () => {
      setSelected(new Set());
      setSelectedFolders(new Set());
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
  const folders = useMemo(() => review.data?.leftoverFolders ?? [], [review.data]);
  const selectedItems = items.filter((item) => selected.has(item.storageFileId));
  const selectedFolderItems = folders.filter((folder) => selectedFolders.has(folder.folderId));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.sizeBytes, 0) + selectedFolderItems.reduce((total, folder) => total + folder.totalBytes, 0);
  const selectedCount = selected.size + selectedFolders.size;
  const heldHere = (held.data ?? []).filter((file) => file.rootType === rootType);
  const stale = Boolean(review.data?.staleWarning);
  const busy = purge.isPending || restore.isPending;
  // Results land when the purge job finishes, not when it is queued, so refresh once it stops running.
  useEffect(() => {
    if (wasRunning.current && !purgeRunning) {
      for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary", "re-requests"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = purgeRunning;
  }, [purgeRunning, queryClient]);
  const files = (count: number) => `${formatNumber(count)} ${count === 1 ? "file" : "files"}`;
  const selectionLabel = () =>
    [selected.size ? files(selected.size) : "", selectedFolders.size ? `${formatNumber(selectedFolders.size)} ${selectedFolders.size === 1 ? "folder" : "folders"}` : ""].filter(Boolean).join(" and ");

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
        {review.data?.storageStaleWarning ? (
          <p className="panel-message storage-stale-warning">
            <TriangleAlert size={14} /> {review.data.storageStaleWarning}
          </p>
        ) : null}
        {review.data ? (
          <>
            <div className="orphan-categories" role="group" aria-label="Orphan categories">
              <button type="button" className={category === "all" ? "orphan-category selected" : "orphan-category"} aria-pressed={category === "all"} onClick={() => { setCategory("all"); setPage(0); }}>
                <strong>All orphans</strong>
                <small>
                  {files(items.length)}, {formatBytes(items.reduce((total, item) => total + item.sizeBytes, 0))}
                  {review.data.hollowCount ? `, ${formatNumber(review.data.hollowCount)} hollow` : ""}
                  {review.data.damagedCount ? `, ${formatNumber(review.data.damagedCount)} damaged` : ""}
                </small>
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
              <button type="button" className="secondary" disabled={busy || selectedCount === 0} onClick={() => { setSelected(new Set()); setSelectedFolders(new Set()); setConfirming(false); }}>
                Clear selection
              </button>
              <button type="button" className="secondary" disabled={busy || stale || purgeRunning || !items.some((item) => !item.protectedReason)} onClick={() => setPurgeAllOpen(true)}>
                <Trash2 size={14} /> Purge all eligible
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
                        {item.hollow ? <span className="orphan-protected">Hollow: almost none of this file is stored on disk</span> : null}
                        {item.integrity === "partial_hollow" ? <span className="orphan-protected">Damaged: {item.zeroSamples ?? "several"} of 24 sampled regions are zero-filled</span> : null}
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
                {formatNumber(selectedCount)} selected ({formatBytes(selectedBytes)})
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
            <section className="orphan-folders" aria-labelledby={`folders-${rootType}-heading`}>
              <h3 id={`folders-${rootType}-heading`}>Folders with no video</h3>
              <p className="muted">Folders left with only subtitles, artwork, samples, or nothing at all. Each folder is walked again right before it is purged and is skipped if a video, symlink, or recent change appears.</p>
              {folders.length === 0 ? (
                <p className="muted">No folders without video were found by the last storage scan.</p>
              ) : (
                <>
                  <div className="orphan-toolbar">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || stale || !folders.some((folder) => !folder.protectedReason && !selectedFolders.has(folder.folderId))}
                      onClick={() => {
                        setSelectedFolders((current) => new Set([...current, ...folders.filter((folder) => !folder.protectedReason).map((folder) => folder.folderId)]));
                        setConfirming(false);
                      }}
                    >
                      Select all folders ({formatNumber(folders.filter((folder) => !folder.protectedReason).length)})
                    </button>
                  </div>
                  <div className="orphan-table-scroll" tabIndex={0} aria-label="Folders with no video">
                    <table>
                      <thead>
                        <tr>
                          <th aria-label="Select" />
                          <th>Folder</th>
                          <th>Files</th>
                          <th>Size</th>
                          <th>Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {folders.map((folder) => (
                          <tr key={folder.folderId}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select folder ${folder.relativePath}`}
                                checked={selectedFolders.has(folder.folderId)}
                                disabled={busy || stale || Boolean(folder.protectedReason)}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setSelectedFolders((current) => {
                                    const next = new Set(current);
                                    if (checked) next.add(folder.folderId);
                                    else next.delete(folder.folderId);
                                    return next;
                                  });
                                  setConfirming(false);
                                }}
                              />
                            </td>
                            <td>
                              <strong>{folder.relativePath.split("/").at(-1) ?? folder.relativePath}</strong>
                              <span className="orphan-path">{folder.relativePath}</span>
                              {folder.protectedReason ? <span className="orphan-protected">Protected: {folder.protectedReason}</span> : null}
                            </td>
                            <td className="orphan-nowrap">{formatNumber(folder.fileCount)}</td>
                            <td className="orphan-nowrap">{formatBytes(folder.totalBytes)}</td>
                            <td className="orphan-nowrap">{folder.newestMtimeMs ? formatDate(new Date(folder.newestMtimeMs).toISOString()) : "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
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
              <button type="button" disabled={busy || stale || selectedCount === 0} onClick={() => setConfirming(true)}>
                <Trash2 size={16} /> Purge selected
              </button>
            </div>
            {confirming ? (
              <PurgeConfirmation
                question={
                  mode === "hold"
                    ? `Move ${selectionLabel()} (${formatBytes(selectedBytes)}) on ${rootLabel} to the holding area? They can be restored for ${review.data.holdDays} days, then they are permanently deleted.`
                    : `Permanently delete ${selectionLabel()} (${formatBytes(selectedBytes)}) on ${rootLabel}? This cannot be undone.`
                }
                confirmLabel={mode === "hold" ? "Move to holding area" : "Delete permanently"}
                storageFileIds={[...selected]}
                busy={busy}
                pending={purge.isPending}
                onConfirm={(reRequest) => purge.mutate(reRequest)}
                onCancel={() => setConfirming(false)}
              />
            ) : null}
            {purge.data ? (
              <p className="panel-message success">
                {purgeRunning ? `Orphan purge job #${purge.data.jobId} is running. This list refreshes when it finishes.` : `Orphan purge job #${purge.data.jobId} finished. See Recent Jobs for details.`}
              </p>
            ) : null}
            {purge.error ? <p className="panel-message error" role="alert">{purge.error.message}</p> : null}
          </>
        ) : null}

        {purgeAllOpen && review.data
          ? createPortal(
              <PurgeAllDialog
                review={review.data}
                rootType={rootType}
                rootLabel={rootLabel}
                onClose={() => setPurgeAllOpen(false)}
                onDone={() => {
                  setSelected(new Set());
                  setSelectedFolders(new Set());
                  refresh();
                }}
              />,
              document.body
            )
          : null}

        <ReRequestActivity />

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

// Holds the re-request choice, so every new confirmation starts with it off.
function PurgeConfirmation({ question, confirmLabel, storageFileIds, busy, pending, onConfirm, onCancel }: { question: string; confirmLabel: string; storageFileIds: number[]; busy: boolean; pending: boolean; onConfirm: (reRequest: boolean) => void; onCancel: () => void }) {
  const [reRequest, setReRequest] = useState(false);
  return (
    <div className="orphan-confirmation" role="group" aria-label="Confirm orphan purge">
      <p>{question}</p>
      {storageFileIds.length > 0 ? <ReRequestOption storageFileIds={storageFileIds} checked={reRequest} onChange={setReRequest} disabled={busy} /> : null}
      <div className="orphan-toolbar">
        <button type="button" disabled={busy} onClick={() => onConfirm(reRequest && storageFileIds.length > 0)}>
          {pending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} {confirmLabel}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
          <X size={16} /> Cancel
        </button>
      </div>
    </div>
  );
}

function PurgeAllDialog({ review, rootType, rootLabel, onClose, onDone }: { review: OrphanReview; rootType: StorageRootType; rootLabel: string; onClose: () => void; onDone: () => void }) {
  const dialogRef = useModalLifecycle(true, onClose);
  const [includeFolders, setIncludeFolders] = useState(false);
  const [mode, setMode] = useState<OrphanPurgeMode>("hold");
  const [phrase, setPhrase] = useState("");
  const [reRequest, setReRequest] = useState(false);
  const plan = useMemo(() => planPurgeAll(review, includeFolders), [review, includeFolders]);
  const batches = useMemo(() => purgeBatches(plan), [plan]);
  const eligibleFolders = review.leftoverFolders.filter((folder) => !folder.protectedReason);
  const protectedCount = review.items.filter((item) => item.protectedReason).length;
  const requiredPhrase = purgeConfirmationPhrase(rootType, plan.totalCount);
  const needsPhrase = purgeNeedsPhrase(rootType, mode, plan.totalCount);
  const stale = Boolean(review.staleWarning);
  const start = useMutation({
    mutationFn: async () => {
      const jobIds: number[] = [];
      for (const batch of batches) {
        const result = await api.purgeOrphans({ rootType, ...batch, mode, reRequest: reRequest && batch.storageFileIds.length > 0 });
        jobIds.push(result.jobId);
      }
      return jobIds;
    },
    onSettled: onDone
  });
  const ready = !stale && plan.totalCount > 0 && (!needsPhrase || phrase.trim() === requiredPhrase) && !start.isPending && !start.isSuccess;
  const items = (count: number) => `${formatNumber(count)} ${count === 1 ? "item" : "items"}`;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !start.isPending) onClose(); }}>
      <section ref={dialogRef} className="audit-dialog orphan-purge-all-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-all-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">{rootLabel}</span>
            <h2 id="purge-all-title">Purge all eligible orphans</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={start.isPending}>
            <X size={16} />
          </button>
        </div>
        {review.staleWarning ? (
          <p className="panel-message action-error" role="alert">
            <TriangleAlert size={14} /> {review.staleWarning} Purging is blocked until the symlink inventory is refreshed.
          </p>
        ) : null}
        {review.storageStaleWarning ? (
          <p className="panel-message storage-stale-warning">
            <TriangleAlert size={14} /> {review.storageStaleWarning}
          </p>
        ) : null}
        <p data-testid="purge-all-summary">
          <strong>{items(plan.totalCount)}</strong> on {rootLabel}, <strong>{formatBytes(plan.totalBytes)}</strong>. {protectedCount > 0 ? `${formatNumber(protectedCount)} protected ${protectedCount === 1 ? "file is" : "files are"} left alone. ` : ""}Every file is rechecked right before it is touched.
        </p>
        <table className="orphan-purge-breakdown" aria-label="Purge breakdown by category">
          <tbody>
            {plan.byCategory.map((entry) => (
              <tr key={entry.category}>
                <th scope="row">{orphanCategoryLabels[entry.category].label}</th>
                <td>{formatNumber(entry.count)}</td>
                <td>{formatBytes(entry.sizeBytes)}</td>
              </tr>
            ))}
            {includeFolders && plan.folderIds.length > 0 ? (
              <tr>
                <th scope="row">Folders with no video</th>
                <td>{formatNumber(plan.folderIds.length)}</td>
                <td>{formatBytes(plan.folderBytes)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <label className="checkbox-row">
          <input type="checkbox" checked={includeFolders} disabled={eligibleFolders.length === 0 || start.isPending || start.isSuccess} onChange={(event) => { setIncludeFolders(event.target.checked); setPhrase(""); }} />
          Also include leftover folders with no video ({formatNumber(eligibleFolders.length)})
        </label>
        <div className="segmented" role="group" aria-label="Purge mode">
          <button type="button" className={mode === "hold" ? "selected" : ""} aria-pressed={mode === "hold"} disabled={start.isPending || start.isSuccess} onClick={() => { setMode("hold"); setPhrase(""); }}>
            <Archive size={14} /> Hold {review.holdDays} days
          </button>
          <button type="button" className={mode === "delete" ? "selected" : ""} aria-pressed={mode === "delete"} disabled={start.isPending || start.isSuccess} onClick={() => { setMode("delete"); setPhrase(""); }}>
            <Trash2 size={14} /> Delete now
          </button>
        </div>
        <p className="muted">
          {mode === "hold"
            ? `Files move to a hidden .srtl-purged folder and can be restored for ${review.holdDays} days.${rootType === "remote" ? " The remote mount may refuse holds; refused files are reported and left in place." : ""}`
            : "Files are removed immediately. This cannot be undone."}
          {batches.length > 1 ? ` This will be queued as ${batches.length} purge jobs.` : ""}
        </p>
        <ReRequestOption storageFileIds={plan.fileIds} checked={reRequest} onChange={setReRequest} disabled={start.isPending || start.isSuccess} />
        {needsPhrase ? (
          <label className="orphan-phrase">
            <span>
              Type <code>{requiredPhrase}</code> to confirm
            </span>
            <input type="text" value={phrase} autoComplete="off" spellCheck={false} aria-label="Confirmation phrase" disabled={start.isPending || start.isSuccess} onChange={(event) => setPhrase(event.target.value)} />
          </label>
        ) : null}
        {start.isSuccess ? (
          <p className="panel-message success" role="status">
            Queued {start.data.length === 1 ? "purge job" : "purge jobs"}{" "}
            {start.data.map((jobId, index) => (
              <span key={jobId}>
                {index > 0 ? ", " : ""}
                <Link to="/logs" search={{ job: jobId }}>
                  #{jobId}
                </Link>
              </span>
            ))}
            . Follow progress there; the list refreshes when it finishes.
          </p>
        ) : null}
        {start.error ? <p className="panel-message error" role="alert">{start.error.message}</p> : null}
        <div className="orphan-toolbar">
          <button type="button" disabled={!ready} onClick={() => start.mutate()}>
            {start.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} {mode === "hold" ? `Hold ${items(plan.totalCount)}` : `Delete ${items(plan.totalCount)}`}
          </button>
          <button type="button" className="secondary" onClick={onClose} disabled={start.isPending}>
            {start.isSuccess ? "Close" : "Cancel"}
          </button>
        </div>
      </section>
    </div>
  );
}
