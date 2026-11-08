import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Archive, Check, LoaderCircle, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import type { JobRecord, OrphanPurgeMode, OrphanReview, OrphanReviewItem, OrphanReviewLabel, StorageRootType } from "../shared/types";
import { api } from "./api";
import { InfoTooltip, Panel } from "./App";
import { formatBytes, formatDate, formatNumber, useModalLifecycle } from "./appShared";
import { filterOrphans, purgeBatches, purgeConfirmationPhrase, purgeNeedsPhrase, planPurgeAll, sortOrphans, type OrphanReleaseFilter, type OrphanSizeFilter, type OrphanSort } from "./orphanPurgePlan";
import { ReRequestActivity, ReRequestOption } from "./reRequest";

const pageSize = 50;

const nameMatchCaveat = "This compares names only and can be wrong: titles can share a name, and unusual release names are missed.";

const orphanLabels: Record<OrphanReviewLabel, { label: string; detail: string }> = {
  superseded: { label: "Other versions of linked titles", detail: "Another file of the same movie or episode is linked. This one may be older, a duplicate, or just different, so compare its size with the linked file. A larger file is not always a better one." },
  copy_leftover: { label: "Copy leftovers", detail: "SRTL already copied this file to the other storage location." },
  not_in_library: { label: "Not in library", detail: "No symlink exists for this title or episode anymore." },
  srtl_artifact: { label: "SRTL leftovers", detail: "Temporary, kept, or backup files that SRTL created." },
  episode_not_linked: { label: "Title is in the library, episode is not linked", detail: `The release name looks like a title in the library, but no link for that title holds this episode. Not linked does not mean missing: a title that numbers its seasons differently lands here too. Deleting this could lose an episode someone wants, so review before deleting. ${nameMatchCaveat}` },
  title_in_library: { label: "Title is in the library", detail: `No symlink points to this file, but its release name looks like a title in the library. ${nameMatchCaveat}` },
  no_title_match: { label: "No title match", detail: `No symlink points to this file and its release name does not look like a title in the library. The title may still be in the library under another name, so review before deleting. ${nameMatchCaveat} Remote files often belong to the provider's wider library.` }
};

const sizeComparisonLabels = { larger: "Larger than the linked file", same: "Same size as the linked file", smaller: "Smaller than the linked file" };

function ReleaseSummary({ item }: { item: OrphanReviewItem }) {
  return (
    <span className="orphan-path">
      Release {item.releaseName}: {item.releaseStatus === "partly_linked" ? <strong>partly linked, {formatNumber(item.releaseLinkedCount)} of {formatNumber(item.releaseFileCount)} files in use</strong> : `no file linked (${formatNumber(item.releaseFileCount)} ${item.releaseFileCount === 1 ? "file" : "files"})`}
    </span>
  );
}

type PurgeJobProgress = { message?: unknown; failed?: unknown; total?: unknown; firstError?: { filePath?: unknown; message?: unknown } };

// What a finished purge job did, read from the job itself: a purge that failed must not read as finished.
function purgeJobOutcome(job: Pick<JobRecord, "id" | "status" | "progress">): { tone: "success" | "error" | "progress"; text: string } {
  const label = `Orphan purge job #${job.id}`;
  if (job.status === "queued" || job.status === "running") return { tone: "progress", text: `${label} is running. This list refreshes when it finishes.` };
  const progress = (job.progress && typeof job.progress === "object" ? job.progress : {}) as PurgeJobProgress;
  const firstError = typeof progress.firstError?.message === "string" ? ` First error: ${typeof progress.firstError.filePath === "string" ? `${progress.firstError.filePath}: ` : ""}${progress.firstError.message}` : "";
  const counts = typeof progress.failed === "number" && typeof progress.total === "number" ? ` ${formatNumber(progress.failed)} of ${formatNumber(progress.total)} not purged.` : "";
  if (job.status === "failed") return { tone: "error", text: `${label} failed.${counts}${firstError}` };
  if (job.status === "partially_failed") return { tone: "error", text: `${label} partially failed.${counts}${firstError}` };
  if (job.status === "cancelled") return { tone: "error", text: `${label} was stopped. Completed work was kept.` };
  return { tone: "success", text: `${label} finished.` };
}

function PurgeJobResult({ jobId }: { jobId: number }) {
  const job = useQuery({
    queryKey: ["jobs", "orphan-purge-result", jobId],
    queryFn: () => api.job(jobId),
    refetchInterval: (query) => (!query.state.data || query.state.data.status === "queued" || query.state.data.status === "running" ? 3000 : false)
  });
  const outcome = purgeJobOutcome(job.data ?? { id: jobId, status: "queued", progress: null });
  return (
    <p className={`panel-message ${outcome.tone === "error" ? "error" : outcome.tone === "success" ? "success" : "action-progress"}`} role={outcome.tone === "error" ? "alert" : "status"}>
      {outcome.text}{" "}
      <Link to="/logs" search={{ job: jobId }}>
        Open the job log
      </Link>
    </p>
  );
}

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
  const [label, setLabel] = useState<OrphanReviewLabel | "all">("all");
  const [releaseFilter, setReleaseFilter] = useState<OrphanReleaseFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<OrphanSizeFilter>("all");
  const [sort, setSort] = useState<OrphanSort>("path");
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
  const filtered = useMemo(() => sortOrphans(filterOrphans(items, { label, release: releaseFilter, size: sizeFilter, search }), sort), [items, label, releaseFilter, sizeFilter, search, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const folders = useMemo(() => review.data?.leftoverFolders ?? [], [review.data]);
  const selectedItems = items.filter((item) => selected.has(item.storageFileId));
  const selectedFolderItems = folders.filter((folder) => selectedFolders.has(folder.folderId));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.sizeBytes, 0) + selectedFolderItems.reduce((total, folder) => total + folder.totalBytes, 0);
  const selectedCount = selected.size + selectedFolders.size;
  const heldHere = (held.data ?? []).filter((file) => file.rootType === rootType);
  const extraSymlinks = review.data?.extraSymlinks;
  // A purge is refused in either case, so nothing here should look like it could start one.
  const stale = Boolean(review.data?.staleWarning || extraSymlinks?.problems.length);
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
        {extraSymlinks?.problems.length ? (
          <p className="panel-message action-error" role="alert">
            <TriangleAlert size={14} /> {extraSymlinks.problems.join(" ")} Purging is blocked until these folders can be read.
          </p>
        ) : null}
        {review.data?.storageStaleWarning ? (
          <p className="panel-message storage-stale-warning">
            <TriangleAlert size={14} /> {review.data.storageStaleWarning}
          </p>
        ) : null}
        {extraSymlinks?.unmatchedCount ? (
          <p className="panel-message storage-stale-warning">
            <TriangleAlert size={14} /> {formatNumber(extraSymlinks.unmatchedCount)} of {formatNumber(extraSymlinks.linkCount)} symlinks in extra symlink folders point outside both storage locations, so they protect nothing. If that tool sees storage under a different path than SRTL does, its links will not match.
          </p>
        ) : null}
        {review.data ? (
          <>
            <div className="orphan-categories" role="group" aria-label="Orphan categories">
              <button type="button" className={label === "all" ? "orphan-category selected" : "orphan-category"} aria-pressed={label === "all"} onClick={() => { setLabel("all"); setPage(0); }}>
                <strong>All orphans</strong>
                <small>
                  {files(items.length)}, {formatBytes(items.reduce((total, item) => total + item.sizeBytes, 0))}
                  {review.data.hollowCount ? `, ${formatNumber(review.data.hollowCount)} hollow` : ""}
                  {review.data.damagedCount ? `, ${formatNumber(review.data.damagedCount)} damaged` : ""}
                </small>
              </button>
              {review.data.labelSummary.map((entry) => (
                <button key={entry.label} type="button" className={label === entry.label ? "orphan-category selected" : "orphan-category"} aria-pressed={label === entry.label} title={orphanLabels[entry.label].detail} onClick={() => { setLabel(entry.label); setPage(0); }}>
                  <strong>{orphanLabels[entry.label].label}</strong>
                  <small>{files(entry.count)}, {formatBytes(entry.sizeBytes)}</small>
                </button>
              ))}
            </div>
            {label !== "all" ? <p className="muted">{orphanLabels[label].detail}</p> : null}
            {label === "all" && review.data.labelSummary.some((entry) => entry.label === "title_in_library" || entry.label === "episode_not_linked" || entry.label === "no_title_match") ? <p className="muted">Labels about titles: {nameMatchCaveat} {orphanLabels.no_title_match.label} does not rule out a title that is in the library under another name, so review before deleting.</p> : null}
            {sizeFilter === "larger" ? <p className="muted">A larger file is not always a better one, and a smaller one is not always worse. Check before deleting.</p> : null}
            <div className="orphan-toolbar">
              <select aria-label="Filter by release" value={releaseFilter} onChange={(event) => { setReleaseFilter(event.target.value as OrphanReleaseFilter); setPage(0); }}>
                <option value="all">All releases</option>
                <option value="none_linked">No file in the release is linked</option>
                <option value="partly_linked">Release is partly linked</option>
              </select>
              <select aria-label="Filter by size against the linked file" value={sizeFilter} onChange={(event) => { setSizeFilter(event.target.value as OrphanSizeFilter); setPage(0); }}>
                <option value="all">Any size</option>
                <option value="larger">Larger than the linked file</option>
                <option value="not_larger">Not larger than the linked file</option>
              </select>
              <select aria-label="Sort orphans" value={sort} onChange={(event) => { setSort(event.target.value as OrphanSort); setPage(0); }}>
                <option value="path">Sort by path</option>
                <option value="label">Sort by label</option>
                <option value="release">Sort by release, partly linked first</option>
                <option value="size_desc">Sort by size, largest first</option>
                <option value="size_asc">Sort by size, smallest first</option>
                <option value="linked_difference">Sort by size against the linked file</option>
                <option value="modified">Sort by modified, newest first</option>
              </select>
            </div>
            <div className="orphan-toolbar">
              <input type="search" aria-label="Search orphan files" placeholder="Search files" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
              <button type="button" className="secondary" disabled={busy || stale || !filtered.some((item) => !item.protectedReason && !selected.has(item.storageFileId))} onClick={() => selectPurgeable(filtered)}>
                Select all {label === "all" ? "" : orphanLabels[label].label.toLowerCase()} ({formatNumber(filtered.filter((item) => !item.protectedReason).length)})
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
                    <th>Label</th>
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
                        {item.episodeCoverage && item.episodeCoverage.linked < item.episodeCoverage.total ? <span className="orphan-protected">Holds {formatNumber(item.episodeCoverage.total)} episodes, and only {formatNumber(item.episodeCoverage.linked)} of them {item.episodeCoverage.linked === 1 ? "has" : "have"} a linked file</span> : null}
                        <ReleaseSummary item={item} />
                      </td>
                      <td>
                        {orphanLabels[item.label].label}
                        {item.matchedTitle ? <span className="orphan-path">Name looks like {item.matchedTitle}</span> : null}
                      </td>
                      <td className="orphan-nowrap">
                        {formatBytes(item.sizeBytes)}
                        {item.sizeComparison && item.linkedSizeBytes !== null ? <span className={`orphan-size-note ${item.sizeComparison === "larger" ? "orphan-protected" : "orphan-path"}`}>{sizeComparisonLabels[item.sizeComparison]} ({formatBytes(item.linkedSizeBytes)})</span> : null}
                      </td>
                      <td className="orphan-nowrap">{formatDate(new Date(item.mtimeMs).toISOString())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 ? <p className="muted">{items.length ? "No matching orphans." : "No orphans on this storage."}</p> : null}
            {review.data.inUseSkippedCount ? <p className="muted">{formatNumber(review.data.inUseSkippedCount)} {review.data.inUseSkippedCount === 1 ? "item is" : "items are"} not listed because a symlink uses {review.data.inUseSkippedCount === 1 ? "it" : "them"}.</p> : null}
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
                Hold moves files into a hidden .srtl-purged folder on the same storage, where they can be restored until they are permanently deleted after the holding period. Delete now removes them immediately with no undo. {rootType === "remote" ? "The remote mount may not support holding; files it refuses are reported and left in place." : ""} Every file is rechecked right before it is touched: still unlinked, including from any extra symlink folders, unchanged, not part of a copy, and older than 24 hours. Subtitles, artwork, and empty folders are cleaned up with the last video in a folder.
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
            {purge.data ? <PurgeJobResult jobId={purge.data.jobId} /> : null}
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
  const extraProblems = review.extraSymlinks.problems;
  const stale = Boolean(review.staleWarning || extraProblems.length);
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
        {extraProblems.length ? (
          <p className="panel-message action-error" role="alert">
            <TriangleAlert size={14} /> {extraProblems.join(" ")} Purging is blocked until these folders can be read.
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
        <table className="orphan-purge-breakdown" aria-label="Purge breakdown by label">
          <tbody>
            {plan.byLabel.map((entry) => (
              <tr key={entry.label}>
                <th scope="row">{orphanLabels[entry.label].label}</th>
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
