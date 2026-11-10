import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, Equal, LoaderCircle, OctagonX, RotateCcw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import type { JobRecord, OrphanRestoreJobProgress, OrphanPurgeMode, OrphanReview, OrphanReviewItem, OrphanReviewLabel, StorageRootType } from "../shared/types";
import { api } from "./api";
import { InfoTooltip, Panel } from "./App";
import { formatBytes, formatDate, formatNumber, recordFromUnknown, useModalLifecycle } from "./appShared";
import { filterOrphans, purgeBatches, planPurgeAll, sortOrphans, type OrphanReleaseFilter, type OrphanSizeFilter, type OrphanSort } from "./orphanPurgePlan";
import { ReRequestActivity, ReRequestOption, ReRequestPreviewCheck, reRequestExplanation, reRequestOptionLabel } from "./reRequest";
import { SettingsTabs } from "./settingsTabs";
import { jobFinished, useQueuedJob } from "./queuedJob";

const pageSize = 50;

const nameMatchCaveat = "This compares names only and can be wrong: titles can share a name, and unusual release names are missed.";

type LabelTone = "info" | "good" | "warn" | "bad" | "neutral";

// `short` names the chip and tab, `hint` is the one sentence shown inline, `detail` sits behind the info button.
const orphanLabels: Record<OrphanReviewLabel, { label: string; short: string; hint: string; detail: string; tone: LabelTone }> = {
  superseded: { label: "Other versions of linked titles", short: "Other versions", hint: "Another file of the same title is linked.", detail: "Another file of the same movie or episode is linked. This one may be older, a duplicate, or just different, so compare its size with the linked file. A larger file is not always a better one.", tone: "info" },
  copy_leftover: { label: "Copy leftovers", short: "Copy leftovers", hint: "Already copied to the other storage location.", detail: "SRTL already copied this file to the other storage location.", tone: "good" },
  not_in_library: { label: "Not in library", short: "Not in library", hint: "No symlink exists for this title or episode anymore.", detail: "No symlink exists for this title or episode anymore.", tone: "neutral" },
  srtl_artifact: { label: "SRTL leftovers", short: "SRTL leftovers", hint: "Temporary, kept, or backup files that SRTL created.", detail: "Temporary, kept, or backup files that SRTL created.", tone: "neutral" },
  episode_not_linked: { label: "Title is in the library, episode is not linked", short: "Episode not linked", hint: "The show is in the library, but no link holds this episode.", detail: `The release name looks like a title in the library, but no link for that title holds this episode. Not linked does not mean missing: a title that numbers its seasons differently lands here too. Deleting this could lose an episode someone wants, so review before deleting. ${nameMatchCaveat}`, tone: "bad" },
  title_in_library: { label: "Title is in the library", short: "Title in library", hint: "The name looks like a library title, but nothing links this file.", detail: `No symlink points to this file, but its release name looks like a title in the library. ${nameMatchCaveat}`, tone: "warn" },
  no_title_match: { label: "No title match", short: "No title match", hint: "The name does not look like any library title.", detail: `No symlink points to this file and its release name does not look like a title in the library. The title may still be in the library under another name, so review before deleting. ${nameMatchCaveat} Remote files often belong to the provider's wider library.`, tone: "neutral" }
};

const labelOrder: OrphanReviewLabel[] = ["superseded", "copy_leftover", "not_in_library", "srtl_artifact", "title_in_library", "episode_not_linked", "no_title_match"];

const sizeComparisonLabels = { larger: "Larger than the linked file", same: "Same size as the linked file", smaller: "Smaller than the linked file" };

type OrphanView = "files" | "folders" | "held";

// Mirrors OrphanSkippedInUse from the purge API change. Optional so the page works with or without it.
interface SkippedInUse {
  total: number;
  files: number;
  folders: number;
  byReason: { library_link: number; extra_link: number };
}
type ReviewWithSkips = OrphanReview & { skippedInUse?: SkippedInUse };

// Remote storage is a mount that cannot rename, so files cannot be moved into the holding area there.
const cannotHoldReason = "This storage can't hold files, so deletes are immediate.";
const canHoldOn = (rootType: StorageRootType) => rootType === "local";

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function parentPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const countText = (count: number, one: string, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

function toggleIn<T>(set: Set<T>, id: T, checked: boolean): Set<T> {
  const next = new Set(set);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/** A select-all checkbox that shows a dash when only some are chosen. */
function SelectAllBox({ label, total, chosen, disabled, onChange }: { label: string; total: number; chosen: number; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = chosen > 0 && chosen < total;
  }, [chosen, total]);
  return (
    <label className="orv-select-all">
      <input ref={ref} type="checkbox" checked={total > 0 && chosen === total} disabled={disabled || total === 0} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function LabelChip({ label }: { label: OrphanReviewLabel }) {
  const entry = orphanLabels[label];
  return (
    <span className={`orv-chip orv-tone-${entry.tone}`} title={entry.label}>
      {entry.short}
    </span>
  );
}

function SizeCell({ item }: { item: OrphanReviewItem }) {
  const comparison = item.linkedSizeBytes !== null ? item.sizeComparison : null;
  return (
    <>
      <span className="orv-size">{formatBytes(item.sizeBytes)}</span>
      {comparison && item.linkedSizeBytes !== null ? (
        <span className={`orv-delta orv-delta-${comparison}`} title={`${sizeComparisonLabels[comparison]} (${formatBytes(item.linkedSizeBytes)})`}>
          {comparison === "larger" ? <ArrowUp size={12} aria-hidden /> : comparison === "smaller" ? <ArrowDown size={12} aria-hidden /> : <Equal size={12} aria-hidden />}
          <span>
            {comparison === "same" ? "Same as linked" : `${comparison === "larger" ? "Larger" : "Smaller"} than linked`} <span className="orv-muted">({formatBytes(item.linkedSizeBytes)})</span>
          </span>
        </span>
      ) : null}
    </>
  );
}

function FileFlags({ item }: { item: OrphanReviewItem }) {
  const flags: Array<{ text: string; title: string; tone: LabelTone }> = [];
  if (item.hollow) flags.push({ text: "Hollow", title: "Almost none of this file is stored on disk", tone: "bad" });
  if (item.integrity === "partial_hollow") flags.push({ text: "Damaged", title: `${item.zeroSamples ?? "Several"} of 24 sampled regions are zero-filled`, tone: "bad" });
  if (item.episodeCoverage && item.episodeCoverage.linked < item.episodeCoverage.total)
    flags.push({ text: `${formatNumber(item.episodeCoverage.linked)} of ${formatNumber(item.episodeCoverage.total)} episodes linked`, title: `Holds ${formatNumber(item.episodeCoverage.total)} episodes, and only ${formatNumber(item.episodeCoverage.linked)} of them ${item.episodeCoverage.linked === 1 ? "has" : "have"} a linked file`, tone: "warn" });
  if (!flags.length) return null;
  return (
    <>
      {flags.map((flag) => (
        <span key={flag.text} className={`orv-chip orv-chip-small orv-tone-${flag.tone}`} title={flag.title}>
          {flag.text}
          <span className="sr-only">: {flag.title}</span>
        </span>
      ))}
    </>
  );
}

function ReleaseNote({ item }: { item: OrphanReviewItem }) {
  if (item.releaseStatus === "partly_linked")
    return (
      <span className="orv-release orv-release-warn">
        Release partly linked, {formatNumber(item.releaseLinkedCount)} of {formatNumber(item.releaseFileCount)} files in use
      </span>
    );
  if (item.releaseFileCount > 1) return <span className="orv-release">Release of {formatNumber(item.releaseFileCount)} files, none linked</span>;
  return null;
}

// --- Purge job outcome -------------------------------------------------------

interface PurgeJobView {
  job: JobRecord;
  stage: string;
  message: string | null;
  failed: number | null;
  total: number | null;
  firstError: string | null;
}

// The job records its first failure as { filePath, message }; older shapes used a plain string.
function firstErrorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  const record = recordFromUnknown(value);
  const message = typeof record?.message === "string" && record.message.trim() ? record.message : null;
  if (!message) return null;
  const path = typeof record?.filePath === "string" ? record.filePath : "";
  const name = path ? fileName(path) : "";
  return name && !message.includes(name) ? `${name}: ${message}` : message;
}

function purgeJobView(job: JobRecord): PurgeJobView {
  const progress = recordFromUnknown(job.progress) ?? {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    job,
    stage: text(progress.stage) ?? job.status,
    message: text(progress.message),
    failed: number(progress.failed),
    total: number(progress.total),
    firstError: firstErrorText(progress.firstError) ?? text(progress.error)
  };
}

function jobRoot(job: JobRecord): { rootType: string | null; source: string | null } {
  const options = recordFromUnknown(job.options) ?? recordFromUnknown(recordFromUnknown(job.progress)?.options) ?? {};
  return { rootType: typeof options.rootType === "string" ? options.rootType : null, source: typeof options.source === "string" ? options.source : null };
}

const dismissedJobKey = "srtl-orphan-dismissed-job";

function readDismissedJob(): number | null {
  try {
    const value = Number(window.localStorage.getItem(dismissedJobKey));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** What became of a restore this page queued: running, done, or what went wrong. */
function RestoreJobStatus({ jobId, job }: { jobId: number; job: JobRecord | null }) {
  const progress = (job?.progress ?? null) as Partial<OrphanRestoreJobProgress> | null;
  const jobLink = (
    <Link to="/logs" search={{ job: jobId }}>
      Open job #{jobId}
    </Link>
  );
  if (!job || !jobFinished(job)) {
    return (
      <p className="panel-message" role="status">
        <LoaderCircle size={14} className="spin-icon" aria-hidden /> Restore job #{jobId} is running. {progress?.message ?? "The list refreshes when it finishes."} {jobLink}
      </p>
    );
  }
  if (job.status === "completed") {
    return <p className="panel-message success">Restored {countText(progress?.restored ?? 0, "file")}. Rescan to relink them if needed.</p>;
  }
  const detail = progress?.firstError ? ` First error: ${progress.firstError.message}` : "";
  return (
    <p className="panel-message error" role="alert">
      {progress?.message ?? `Restore job #${jobId} ${job.status.replace("_", " ")}.`}
      {detail} {jobLink}
    </p>
  );
}

/** The latest purge job on this storage: running, failed, or (when started from this page) finished. A failure stays until dismissed. */
function PurgeJobStatus({ rootType, startedHere, purgeRunning }: { rootType: StorageRootType; startedHere: number[]; purgeRunning: boolean }) {
  const [dismissed, setDismissed] = useState<number | null>(() => readDismissedJob());
  const recent = useQuery({
    queryKey: ["jobs", "orphan-purge-recent"],
    queryFn: () => api.jobs({ completedWithinMinutes: 1440, limit: 25 }),
    refetchInterval: purgeRunning || startedHere.length ? 3000 : 30_000
  });
  const latest = useMemo(() => {
    const purges = (recent.data ?? []).filter((job) => job.type === "orphan_purge" && jobRoot(job).source !== "damaged" && (jobRoot(job).rootType ?? rootType) === rootType);
    return purges.sort((left, right) => right.id - left.id)[0] ?? null;
  }, [recent.data, rootType]);
  const view = latest ? purgeJobView(latest) : null;
  const failed = view !== null && (latest!.status === "failed" || latest!.status === "partially_failed");
  const events = useQuery({
    queryKey: ["job-events", latest?.id, "first-error"],
    queryFn: () => api.jobEvents(latest!.id, 200),
    enabled: failed && !view?.firstError
  });
  if (!view || !latest) return null;
  const jobLink = (
    <Link to="/logs" search={{ job: latest.id }}>
      Open job #{latest.id}
    </Link>
  );
  if (latest.status === "queued" || latest.status === "running") {
    return (
      <div className="orv-banner orv-banner-progress" role="status">
        <LoaderCircle size={16} className="spin-icon" aria-hidden />
        <div>
          <strong>Purge job #{latest.id} is running.</strong> <span>{view.message ?? "The list refreshes when it finishes."}</span>
        </div>
        {jobLink}
      </div>
    );
  }
  if (failed) {
    if (dismissed === latest.id) return null;
    const eventError = (events.data ?? [])
      .filter((event) => event.level === "error")
      .sort((left, right) => left.id - right.id)
      .map((event) => recordFromUnknown(event.data)?.reason)
      .find((reason): reason is string => typeof reason === "string");
    const firstError = view.firstError ?? eventError ?? null;
    const partial = latest.status === "partially_failed";
    return (
      <div className="orv-banner orv-banner-bad" role="alert">
        <OctagonX size={18} aria-hidden />
        <div>
          <strong>
            Purge job #{latest.id} {partial ? "partly failed" : "failed"}
            {view.failed !== null && view.total !== null ? `: ${formatNumber(view.failed)} of ${countText(view.total, "item")} not purged.` : "."}
          </strong>
          {firstError ? <span className="orv-banner-detail">First error: {firstError}</span> : view.message ? <span className="orv-banner-detail">{view.message}</span> : null}
        </div>
        {jobLink}
        <button
          type="button"
          className="icon-button orv-banner-close"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(latest.id);
            try {
              window.localStorage.setItem(dismissedJobKey, String(latest.id));
            } catch {
              // Only a convenience; the banner simply comes back.
            }
          }}
        >
          <X size={16} />
        </button>
      </div>
    );
  }
  if (latest.status === "completed" && startedHere.includes(latest.id)) {
    return (
      <div className="orv-banner orv-banner-good" role="status">
        <Check size={16} aria-hidden />
        <div>
          <strong>Purge job #{latest.id} finished.</strong> {view.message ? <span>{view.message}</span> : null}
        </div>
        {jobLink}
      </div>
    );
  }
  return null;
}

// --- Page --------------------------------------------------------------------

export function OrphanReviewPanel({ rootType, rootLabel, autoOpenPurgeAll = false, openHeld = false }: { rootType: StorageRootType; rootLabel: string; autoOpenPurgeAll?: boolean; openHeld?: boolean }) {
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: ["orphan-review", rootType], queryFn: () => api.orphanReview(rootType) });
  const held = useQuery({ queryKey: ["held-orphans"], queryFn: api.heldOrphans });
  const activeJobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const purgeRunning = (activeJobs.data ?? []).some((job) => job.type === "orphan_purge");
  const wasRunning = useRef(false);
  const [view, setView] = useState<OrphanView>(openHeld ? "held" : "files");
  const [label, setLabel] = useState<OrphanReviewLabel | "all">("all");
  const [releaseFilter, setReleaseFilter] = useState<OrphanReleaseFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<OrphanSizeFilter>("all");
  const [sort, setSort] = useState<OrphanSort>("path");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set());
  // Hold is the safe default where the storage can hold files; elsewhere every purge is a delete.
  const canHold = canHoldOn(rootType);
  const [mode, setMode] = useState<OrphanPurgeMode>(canHold ? "hold" : "delete");
  const [reRequest, setReRequest] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [purgeAllOpen, setPurgeAllOpen] = useState(autoOpenPurgeAll);
  const [howOpen, setHowOpen] = useState(false);
  const [selectedHeld, setSelectedHeld] = useState<Set<number>>(new Set());
  const [startedJobs, setStartedJobs] = useState<number[]>([]);
  const refresh = () => {
    for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary", "re-requests", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setSelectedFolders(new Set());
    setConfirming(false);
    setReRequest(false);
  };
  const purge = useMutation({
    mutationFn: () => api.purgeOrphans({ rootType, storageFileIds: [...selected], folderIds: [...selectedFolders], mode, reRequest: reRequest && selected.size > 0 }),
    onSuccess: (result) => {
      setStartedJobs((current) => [...current, result.jobId]);
      clearSelection();
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
  // The worker restores the files; the list refreshes when its job finishes.
  const restoreJob = useQueuedJob(restore.data?.jobId ?? null, refresh);
  const restoreRunning = Boolean(restore.data && !jobFinished(restoreJob.data));

  const data = review.data as ReviewWithSkips | undefined;
  const allItems = useMemo(() => data?.items ?? [], [data]);
  // Protected files can never be purged, so they are counted, not listed with checkboxes that do nothing.
  const items = useMemo(() => allItems.filter((item) => !item.protectedReason), [allItems]);
  const protectedItems = useMemo(() => allItems.filter((item) => item.protectedReason), [allItems]);
  const filtered = useMemo(() => sortOrphans(filterOrphans(items, { label, release: releaseFilter, size: sizeFilter, search }), sort), [items, label, releaseFilter, sizeFilter, search, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const allFolders = useMemo(() => data?.leftoverFolders ?? [], [data]);
  const folders = useMemo(() => allFolders.filter((folder) => !folder.protectedReason), [allFolders]);
  const protectedFolderCount = allFolders.length - folders.length;
  const labelCounts = useMemo(() => {
    const counts = new Map<OrphanReviewLabel, number>();
    for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return counts;
  }, [items]);
  const selectedItems = items.filter((item) => selected.has(item.storageFileId));
  const selectedFolderItems = folders.filter((folder) => selectedFolders.has(folder.folderId));
  const selectedBytes = selectedItems.reduce((total, item) => total + item.sizeBytes, 0) + selectedFolderItems.reduce((total, folder) => total + folder.totalBytes, 0);
  const selectedCount = selected.size + selectedFolders.size;
  const heldHere = (held.data ?? []).filter((file) => file.rootType === rootType);
  const extraSymlinks = data?.extraSymlinks;
  const inUse = data?.skippedInUse;
  const totalBytes = items.reduce((total, item) => total + item.sizeBytes, 0);
  // A purge is refused in either case, so nothing here should look like it could start one.
  const stale = Boolean(data?.staleWarning || extraSymlinks?.problems.length);
  const busy = purge.isPending || restore.isPending || restoreRunning;
  const filteredSelected = filtered.filter((item) => selected.has(item.storageFileId)).length;
  // Results land when the purge job finishes, not when it is queued, so refresh once it stops running.
  useEffect(() => {
    if (wasRunning.current && !purgeRunning) {
      for (const key of ["orphan-review", "held-orphans", "storage-file-tree", "inventory-summary", "re-requests", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    wasRunning.current = purgeRunning;
  }, [purgeRunning, queryClient]);
  const selectionLabel = [selected.size ? countText(selected.size, "file") : "", selectedFolders.size ? countText(selectedFolders.size, "folder") : ""].filter(Boolean).join(" and ");
  const resetPage = () => setPage(0);

  const inUseSplit = inUse && inUse.byReason.library_link && inUse.byReason.extra_link ? ` (${formatNumber(inUse.byReason.library_link)} by library links, ${formatNumber(inUse.byReason.extra_link)} by extra symlink folders)` : inUse?.byReason.extra_link ? " by extra symlink folders" : "";
  const skippedParts = [inUse?.total ? `${formatNumber(inUse.total)} in use${inUseSplit}` : "", protectedItems.length ? `${formatNumber(protectedItems.length)} protected` : "", protectedFolderCount ? countText(protectedFolderCount, "protected folder") : ""].filter(Boolean);

  return (
    <Panel title={`Review ${rootLabel} orphans`} icon={<Trash2 size={18} />} className="orv-panel">
      <div className="orv">
        {review.isLoading ? <p className="panel-message">Loading orphans...</p> : null}
        {review.error ? <p className="panel-message error">{review.error.message}</p> : null}
        {data?.staleWarning ? (
          <div className="orv-banner orv-banner-bad" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <div>{data.staleWarning}</div>
          </div>
        ) : null}
        {extraSymlinks?.problems.length ? (
          <div className="orv-banner orv-banner-bad" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <div>
              {extraSymlinks.problems.join(" ")} Purging is blocked until these folders can be read.
            </div>
          </div>
        ) : null}
        {data?.storageStaleWarning ? (
          <div className="orv-banner orv-banner-warn">
            <TriangleAlert size={18} aria-hidden />
            <div>{data.storageStaleWarning}</div>
          </div>
        ) : null}
        {extraSymlinks?.unmatchedCount ? (
          <div className="orv-banner orv-banner-warn">
            <TriangleAlert size={18} aria-hidden />
            <div>
              <strong>{formatNumber(extraSymlinks.unmatchedCount)} of {formatNumber(extraSymlinks.linkCount)} extra symlinks protect nothing.</strong>{" "}
              <span className="orv-banner-detail">They point outside both storage locations. If that tool sees storage under a different path than SRTL does, its links will not match.</span>
            </div>
          </div>
        ) : null}
        <PurgeJobStatus rootType={rootType} startedHere={startedJobs} purgeRunning={purgeRunning} />

        {data ? (
          <>
            <header className="orv-header">
              <div className="orv-totals">
                <p className="orv-total-line">
                  <strong>{countText(items.length, "file")}</strong>
                  <span className="orv-total-sep" aria-hidden>
                    ·
                  </span>
                  <strong>{formatBytes(totalBytes)}</strong>
                  <span className="orv-total-label">can be purged on {rootLabel}</span>
                </p>
                <p className="orv-skipped">
                  {[data.hollowCount ? `${formatNumber(data.hollowCount)} hollow` : "", data.damagedCount ? `${formatNumber(data.damagedCount)} damaged` : ""].filter(Boolean).join(", ")}
                  {(data.hollowCount || data.damagedCount) && skippedParts.length ? " · " : ""}
                  {skippedParts.length ? `${skippedParts.join(", ")} not listed.` : ""}
                </p>
              </div>
              <div className="orv-header-actions">
                <button type="button" className="secondary orv-how" aria-expanded={howOpen} aria-controls={`orv-how-${rootType}`} onClick={() => setHowOpen((value) => !value)}>
                  How this works <ChevronDown size={14} aria-hidden className="orv-chevron" />
                </button>
                <button type="button" className="danger orv-purge-all" disabled={busy || stale || purgeRunning || items.length === 0} onClick={() => setPurgeAllOpen(true)}>
                  <Trash2 size={15} /> Purge all eligible
                </button>
              </div>
            </header>
            {howOpen ? (
              <div className="orv-how-panel" id={`orv-how-${rootType}`}>
                <ul>
                  <li>
                    <strong>What is listed:</strong> video files nothing in the library links to. Files a symlink still uses, or that changed in the last 24 hours, are left out.
                  </li>
                  <li>
                    <strong>Labels about titles:</strong> {nameMatchCaveat} {orphanLabels.no_title_match.short} does not rule out a title that is in the library under another name.
                  </li>
                  <li>
                    {canHold ? (
                      <>
                        <strong>Hold {data.holdDays} days</strong> moves files into a hidden .srtl-purged folder on the same storage, where they can be restored until the holding period ends. <strong>Delete now</strong> removes them with no undo.
                      </>
                    ) : (
                      <>
                        <strong>Deletes are immediate here.</strong> This storage can't move files into a holding area, so purged files are removed with no undo.
                      </>
                    )}
                  </li>
                  <li>
                    <strong>Safety checks:</strong> every file is rechecked right before it is touched: still unlinked, including from any extra symlink folders, unchanged, not part of a copy, and older than 24 hours. Subtitles, artwork, and empty folders go with the last video in a folder.
                  </li>
                </ul>
              </div>
            ) : null}
            <SettingsTabs
              label="Orphan review sections"
              idPrefix={`orv-${rootType}`}
              className="orv-views"
              active={view}
              onSelect={setView}
              tabs={[
                { key: "files", label: <>Video files <span className="orv-tab-count">{formatNumber(items.length)}</span></> },
                { key: "folders", label: <>Folders with no video <span className="orv-tab-count">{formatNumber(folders.length)}</span></> },
                { key: "held", label: <>Holding area <span className="orv-tab-count">{formatNumber(heldHere.length)}</span></> }
              ]}
            />

            {view === "files" ? (
              <div role="tabpanel" id={`orv-${rootType}-panel-files`} aria-labelledby={`orv-${rootType}-tab-files`} className="orv-view">
                <div className="orv-labels" role="group" aria-label="Orphan categories">
                  <button type="button" className="orv-label-tab" aria-pressed={label === "all"} onClick={() => { setLabel("all"); resetPage(); }}>
                    All <span className="orv-count">{formatNumber(items.length)}</span>
                  </button>
                  {labelOrder
                    .filter((key) => labelCounts.has(key))
                    .map((key) => (
                      <button key={key} type="button" className={`orv-label-tab orv-tone-${orphanLabels[key].tone}`} aria-pressed={label === key} title={orphanLabels[key].label} onClick={() => { setLabel(key); resetPage(); }}>
                        <span className="orv-dot" aria-hidden />
                        {orphanLabels[key].short} <span className="orv-count">{formatNumber(labelCounts.get(key) ?? 0)}</span>
                      </button>
                    ))}
                </div>
                <p className="orv-hint">
                  {label === "all" ? "Every video file that nothing in the library links to." : orphanLabels[label].hint}
                  {sizeFilter === "larger" ? " A larger file is not always a better one." : ""}
                  <InfoTooltip label={label === "all" ? "About these labels" : `About ${orphanLabels[label].short}`}>{label === "all" ? `Labels about titles: ${nameMatchCaveat} ${orphanLabels.no_title_match.short} does not rule out a title that is in the library under another name, so review before deleting.` : orphanLabels[label].detail}</InfoTooltip>
                </p>
                <div className="orv-filters">
                  <label className="orv-search">
                    <Search size={15} aria-hidden />
                    <input type="search" aria-label="Search orphan files" placeholder="Search files" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} />
                  </label>
                  <select aria-label="Filter by release" value={releaseFilter} onChange={(event) => { setReleaseFilter(event.target.value as OrphanReleaseFilter); resetPage(); }}>
                    <option value="all">All releases</option>
                    <option value="none_linked">No file in the release is linked</option>
                    <option value="partly_linked">Release is partly linked</option>
                  </select>
                  <select aria-label="Filter by size against the linked file" value={sizeFilter} onChange={(event) => { setSizeFilter(event.target.value as OrphanSizeFilter); resetPage(); }}>
                    <option value="all">Any size</option>
                    <option value="larger">Larger than the linked file</option>
                    <option value="not_larger">Not larger than the linked file</option>
                  </select>
                  <select aria-label="Sort orphans" value={sort} onChange={(event) => { setSort(event.target.value as OrphanSort); resetPage(); }}>
                    <option value="path">Sort by path</option>
                    <option value="label">Sort by label</option>
                    <option value="release">Sort by release, partly linked first</option>
                    <option value="size_desc">Sort by size, largest first</option>
                    <option value="size_asc">Sort by size, smallest first</option>
                    <option value="linked_difference">Sort by size against the linked file</option>
                    <option value="modified">Sort by modified, newest first</option>
                  </select>
                </div>
                <div className="orv-table-bar">
                  <SelectAllBox
                    label={`Select all ${formatNumber(filtered.length)}${label === "all" ? "" : ` ${orphanLabels[label].short.toLowerCase()}`}`}
                    total={filtered.length}
                    chosen={filteredSelected}
                    disabled={busy || stale}
                    onChange={(checked) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const item of filtered) {
                          if (checked) next.add(item.storageFileId);
                          else next.delete(item.storageFileId);
                        }
                        return next;
                      });
                      setConfirming(false);
                    }}
                  />
                  <Pager page={currentPage} pageCount={pageCount} total={filtered.length} onPage={setPage} />
                </div>
                {filtered.length === 0 ? (
                  <p className="orv-empty">{items.length ? "No files match these filters." : "No orphans on this storage."}</p>
                ) : (
                  <div className="orv-table-wrap">
                    <table className="orv-table" aria-label="Orphan files">
                      <thead>
                        <tr>
                          <th className="orv-col-check">
                            <span className="sr-only">Select</span>
                          </th>
                          <th>File</th>
                          <th className="orv-col-label">Label</th>
                          <th className="orv-col-size">Size</th>
                          <th className="orv-col-date">Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((item) => {
                          const isSelected = selected.has(item.storageFileId);
                          const dir = parentPath(item.relativePath);
                          return (
                            <tr key={item.storageFileId} className={isSelected ? "is-selected" : undefined}>
                              <td className="orv-col-check">
                                <input type="checkbox" aria-label={`Select ${fileName(item.relativePath)}`} checked={isSelected} disabled={busy || stale} onChange={(event) => { setSelected((current) => toggleIn(current, item.storageFileId, event.target.checked)); setConfirming(false); }} />
                              </td>
                              <td className="orv-col-file">
                                <div className="orv-name-line">
                                  <span className="orv-name">{fileName(item.relativePath)}</span>
                                  <FileFlags item={item} />
                                </div>
                                <div className="orv-sub">
                                  {dir ? <span className="orv-dir" title={item.relativePath}>{dir}</span> : null}
                                  <ReleaseNote item={item} />
                                </div>
                              </td>
                              <td className="orv-col-label">
                                <LabelChip label={item.label} />
                                {item.matchedTitle ? <span className="orv-sub orv-match">Name looks like {item.matchedTitle}</span> : null}
                              </td>
                              <td className="orv-col-size">
                                <SizeCell item={item} />
                              </td>
                              <td className="orv-col-date" title={formatDate(new Date(item.mtimeMs).toISOString())}>
                                {shortDate(item.mtimeMs)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {pageCount > 1 ? (
                  <div className="orv-table-bar orv-table-bar-end">
                    <Pager page={currentPage} pageCount={pageCount} total={filtered.length} onPage={setPage} />
                  </div>
                ) : null}
              </div>
            ) : null}

            {view === "folders" ? (
              <div role="tabpanel" id={`orv-${rootType}-panel-folders`} aria-labelledby={`orv-${rootType}-tab-folders`} className="orv-view">
                <p className="orv-hint">
                  Folders left with only subtitles, artwork, samples, or nothing at all.
                  <InfoTooltip label="About folders with no video">Each folder is walked again right before it is purged and is skipped if a video, symlink, or recent change appears.</InfoTooltip>
                </p>
                {folders.length === 0 ? (
                  <p className="orv-empty">No folders without video were found by the last storage scan.</p>
                ) : (
                  <>
                    <div className="orv-table-bar">
                      <SelectAllBox
                        label={`Select all ${countText(folders.length, "folder")}`}
                        total={folders.length}
                        chosen={selectedFolders.size}
                        disabled={busy || stale}
                        onChange={(checked) => {
                          setSelectedFolders(checked ? new Set(folders.map((folder) => folder.folderId)) : new Set());
                          setConfirming(false);
                        }}
                      />
                    </div>
                    <div className="orv-table-wrap">
                      <table className="orv-table" aria-label="Folders with no video">
                        <thead>
                          <tr>
                            <th className="orv-col-check">
                              <span className="sr-only">Select</span>
                            </th>
                            <th>Folder</th>
                            <th className="orv-col-num">Files</th>
                            <th className="orv-col-size">Size</th>
                            <th className="orv-col-date">Modified</th>
                          </tr>
                        </thead>
                        <tbody>
                          {folders.map((folder) => {
                            const isSelected = selectedFolders.has(folder.folderId);
                            return (
                              <tr key={folder.folderId} className={isSelected ? "is-selected" : undefined}>
                                <td className="orv-col-check">
                                  <input type="checkbox" aria-label={`Select folder ${folder.relativePath}`} checked={isSelected} disabled={busy || stale} onChange={(event) => { setSelectedFolders((current) => toggleIn(current, folder.folderId, event.target.checked)); setConfirming(false); }} />
                                </td>
                                <td className="orv-col-file">
                                  <div className="orv-name-line">
                                    <span className="orv-name">{fileName(folder.relativePath)}</span>
                                  </div>
                                  <div className="orv-sub">
                                    <span className="orv-dir" title={folder.relativePath}>{parentPath(folder.relativePath) || "/"}</span>
                                  </div>
                                </td>
                                <td className="orv-col-num">{formatNumber(folder.fileCount)}</td>
                                <td className="orv-col-size">
                                  <span className="orv-size">{formatBytes(folder.totalBytes)}</span>
                                </td>
                                <td className="orv-col-date">{folder.newestMtimeMs ? shortDate(folder.newestMtimeMs) : "-"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {view === "held" ? (
              <div role="tabpanel" id={`orv-${rootType}-panel-held`} aria-labelledby={`orv-${rootType}-tab-held`} className="orv-view">
                <p className="orv-hint">Held files on {rootLabel} can be restored until they are deleted.</p>
                {heldHere.length === 0 ? (
                  <p className="orv-empty">No files are waiting in the holding area.</p>
                ) : (
                  <>
                    <div className="orv-table-bar">
                      <SelectAllBox label={`Select all ${countText(heldHere.length, "file")}`} total={heldHere.length} chosen={heldHere.filter((file) => selectedHeld.has(file.operationId)).length} disabled={busy} onChange={(checked) => setSelectedHeld(checked ? new Set(heldHere.map((file) => file.operationId)) : new Set())} />
                      <button type="button" className="orv-primary orv-restore" disabled={busy || selectedHeld.size === 0} onClick={() => restore.mutate()}>
                        {restore.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <RotateCcw size={16} />} Restore selected{selectedHeld.size ? ` (${formatNumber(selectedHeld.size)})` : ""}
                      </button>
                    </div>
                    <div className="orv-table-wrap">
                      <table className="orv-table" aria-label="Held orphan files">
                        <thead>
                          <tr>
                            <th className="orv-col-check">
                              <span className="sr-only">Select</span>
                            </th>
                            <th>File</th>
                            <th className="orv-col-size">Size</th>
                            <th className="orv-col-date">Deleted on</th>
                          </tr>
                        </thead>
                        <tbody>
                          {heldHere.map((file) => {
                            const isSelected = selectedHeld.has(file.operationId);
                            return (
                              <tr key={file.operationId} className={isSelected ? "is-selected" : undefined}>
                                <td className="orv-col-check">
                                  <input type="checkbox" aria-label={`Select held ${file.filePath}`} checked={isSelected} disabled={busy} onChange={(event) => setSelectedHeld((current) => toggleIn(current, file.operationId, event.target.checked))} />
                                </td>
                                <td className="orv-col-file">
                                  <div className="orv-name-line">
                                    <span className="orv-name">{fileName(file.filePath)}</span>
                                  </div>
                                  <div className="orv-sub">
                                    <span className="orv-dir" title={file.filePath}>{parentPath(file.filePath)}</span>
                                  </div>
                                </td>
                                <td className="orv-col-size">
                                  <span className="orv-size">{formatBytes(file.sizeBytes)}</span>
                                </td>
                                <td className="orv-col-date" title={formatDate(file.purgeAfter)}>
                                  {shortDate(Date.parse(file.purgeAfter))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {restore.data ? <RestoreJobStatus jobId={restore.data.jobId} job={restoreJob.data ?? null} /> : null}
                {restore.error ? <p className="panel-message error" role="alert">{restore.error.message}</p> : null}
                <ReRequestActivity />
              </div>
            ) : null}

            {purge.error ? (
              <div className="orv-banner orv-banner-bad" role="alert">
                <OctagonX size={18} aria-hidden />
                <div>{purge.error.message}</div>
              </div>
            ) : null}

            {selectedCount > 0 && view !== "held" ? (
              <div className={`orv-action-bar${mode === "delete" ? " is-delete" : ""}`} role="region" aria-label="Selected orphans">
                {confirming ? (
                  <div className="orv-confirm" role="group" aria-label="Confirm orphan purge">
                    <p className="orv-confirm-question">
                      {mode === "hold" ? (
                        <>
                          Move <strong>{selectionLabel}</strong> ({formatBytes(selectedBytes)}) on {rootLabel} to the holding area? They can be restored for {data.holdDays} days, then they are permanently deleted.
                        </>
                      ) : (
                        <>
                          Permanently delete <strong>{selectionLabel}</strong> ({formatBytes(selectedBytes)}) on {rootLabel}? This cannot be undone.
                        </>
                      )}
                      {reRequest && selected.size ? " Radarr or Sonarr will be asked for a new copy." : ""}
                    </p>
                    <ReRequestPreviewCheck storageFileIds={[...selected]} enabled={reRequest} />
                    <div className="orv-confirm-actions">
                      <button type="button" className={mode === "delete" ? "orv-danger-solid" : undefined} disabled={busy} onClick={() => purge.mutate()}>
                        {purge.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} {mode === "hold" ? "Move to holding area" : "Delete permanently"}
                      </button>
                      <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                        <X size={16} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="orv-action-row">
                  <div className="orv-action-choices">
                  <p className="orv-action-count" aria-live="polite">
                    <strong>{selectionLabel}</strong> selected <span className="orv-action-size">{formatBytes(selectedBytes)}</span>
                  </p>
                  <div className="orv-mode">
                    <div className="segmented orv-mode-switch" role="group" aria-label="Purge mode">
                      <button type="button" className={mode === "hold" ? "selected" : ""} aria-pressed={mode === "hold"} disabled={busy || !canHold} aria-describedby={canHold ? undefined : `orv-no-hold-${rootType}`} onClick={() => { setMode("hold"); setConfirming(false); }}>
                        <Archive size={14} /> Hold {data.holdDays} days
                      </button>
                      <button type="button" className={mode === "delete" ? "selected orv-mode-delete" : "orv-mode-delete"} aria-pressed={mode === "delete"} disabled={busy} onClick={() => { setMode("delete"); setConfirming(false); }}>
                        <Trash2 size={14} /> Delete now
                      </button>
                    </div>
                    {canHold ? null : (
                      <p className="orv-mode-note" id={`orv-no-hold-${rootType}`}>
                        {cannotHoldReason}
                      </p>
                    )}
                  </div>
                  <span className="orv-rerequest">
                    <label>
                      <input type="checkbox" checked={reRequest} disabled={busy || selected.size === 0} onChange={(event) => { setReRequest(event.target.checked); setConfirming(false); }} />
                      <span>{reRequestOptionLabel}</span>
                    </label>
                    <InfoTooltip label="About re-requests">{reRequestExplanation}</InfoTooltip>
                  </span>
                  </div>
                  <div className="orv-action-buttons">
                    <button type="button" className="secondary" disabled={busy} onClick={clearSelection}>
                      Clear
                    </button>
                    <button type="button" className={mode === "delete" ? "orv-danger-solid" : "orv-primary"} disabled={busy || stale || confirming} onClick={() => setConfirming(true)}>
                      <Trash2 size={16} /> Purge selected
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {purgeAllOpen && review.data
          ? createPortal(
              <PurgeAllDialog
                review={review.data}
                rootType={rootType}
                rootLabel={rootLabel}
                onClose={() => setPurgeAllOpen(false)}
                onQueued={(jobIds) => setStartedJobs((current) => [...current, ...jobIds])}
                onDone={() => {
                  clearSelection();
                  refresh();
                }}
              />,
              document.body
            )
          : null}
      </div>
    </Panel>
  );
}

function Pager({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (page: number) => void }): ReactNode {
  if (total === 0) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="orv-pager">
      <span>
        {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}
      </span>
      {pageCount > 1 ? (
        <>
          <button type="button" className="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>
            Previous
          </button>
          <button type="button" className="secondary" disabled={page + 1 >= pageCount} onClick={() => onPage(page + 1)}>
            Next
          </button>
        </>
      ) : null}
    </div>
  );
}

function PurgeAllDialog({ review, rootType, rootLabel, onClose, onQueued, onDone }: { review: OrphanReview; rootType: StorageRootType; rootLabel: string; onClose: () => void; onQueued: (jobIds: number[]) => void; onDone: () => void }) {
  const dialogRef = useModalLifecycle(true, onClose);
  const [includeFolders, setIncludeFolders] = useState(false);
  const canHold = canHoldOn(rootType);
  const [mode, setMode] = useState<OrphanPurgeMode>(canHold ? "hold" : "delete");
  const [reRequest, setReRequest] = useState(false);
  const plan = useMemo(() => planPurgeAll(review, includeFolders), [review, includeFolders]);
  const batches = useMemo(() => purgeBatches(plan), [plan]);
  const eligibleFolders = review.leftoverFolders.filter((folder) => !folder.protectedReason);
  const protectedCount = review.items.filter((item) => item.protectedReason).length;
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
    onSuccess: onQueued,
    onSettled: onDone
  });
  const ready = !stale && plan.totalCount > 0 && !start.isPending && !start.isSuccess;
  const items = (count: number) => countText(count, "item");

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
                <th scope="row">
                  <LabelChip label={entry.label} />
                </th>
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
          <input type="checkbox" checked={includeFolders} disabled={eligibleFolders.length === 0 || start.isPending || start.isSuccess} onChange={(event) => { setIncludeFolders(event.target.checked) }} />
          Also include leftover folders with no video ({formatNumber(eligibleFolders.length)})
        </label>
        <div className="segmented orv-mode-switch" role="group" aria-label="Purge mode">
          <button type="button" className={mode === "hold" ? "selected" : ""} aria-pressed={mode === "hold"} disabled={!canHold || start.isPending || start.isSuccess} aria-describedby={canHold ? undefined : "purge-all-mode-note"} onClick={() => { setMode("hold") }}>
            <Archive size={14} /> Hold {review.holdDays} days
          </button>
          <button type="button" className={mode === "delete" ? "selected orv-mode-delete" : "orv-mode-delete"} aria-pressed={mode === "delete"} disabled={start.isPending || start.isSuccess} onClick={() => { setMode("delete") }}>
            <Trash2 size={14} /> Delete now
          </button>
        </div>
        <p className="muted" id="purge-all-mode-note">
          {mode === "hold" ? `Files move to a hidden .srtl-purged folder and can be restored for ${review.holdDays} days.` : `${canHold ? "" : `${cannotHoldReason} `}Files are removed immediately. This cannot be undone.`}
          {batches.length > 1 ? ` This will be queued as ${batches.length} purge jobs.` : ""}
        </p>
        <ReRequestOption storageFileIds={plan.fileIds} checked={reRequest} onChange={setReRequest} disabled={start.isPending || start.isSuccess} />
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
          <button type="button" className={mode === "delete" ? "orv-danger-solid" : undefined} disabled={!ready} onClick={() => start.mutate()}>
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
