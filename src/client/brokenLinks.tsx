import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, LoaderCircle, OctagonX, RefreshCw, Search, Trash2, TriangleAlert, Unlink2, X } from "lucide-react";
import type { BrokenLinkCleanupRecord, BrokenLinkItem, BrokenLinkRescanResult, JobRecord } from "../shared/types";
import { api } from "./api";
import { Panel } from "./App";
import { formatDate, formatNumber, recordFromUnknown } from "./appShared";
import { brokenLinkSections, brokenLinkTitleCount, filterBrokenLinks, groupBrokenLinks } from "./brokenLinkPlan";
import { jobFinished, useQueuedJob } from "./queuedJob";
import { SettingsTabs } from "./settingsTabs";

const pageSize = 100;

type BrokenLinkView = "broken" | "removed";

const countText = (count: number, one: string, many = `${one}s`) => `${formatNumber(count)} ${count === 1 ? one : many}`;

function fileName(value: string): string {
  return value.split("/").at(-1) ?? value;
}

function toggleIn<T>(set: Set<T>, id: T, checked: boolean): Set<T> {
  const next = new Set(set);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

const rootNames = { remote: "remote storage", local: "local storage", other: "outside both storage locations" } as const;

const stageLabels: Record<BrokenLinkCleanupRecord["stage"], string> = {
  planned: "Waiting",
  removed: "Removed",
  already_missing: "Already gone",
  skipped: "Skipped, changed",
  failed: "Failed"
};

function rescanResultText(result: BrokenLinkRescanResult): string {
  const parts = [
    `Rescan asked for ${countText(result.asked, "title")}`,
    result.searched ? `search queued for ${countText(result.searched, "item")}` : "",
    result.notMatched ? `${formatNumber(result.notMatched)} not in Radarr or Sonarr` : "",
    result.failed ? `${formatNumber(result.failed)} not sent (paused instance)` : "",
    result.relinked ? `${formatNumber(result.relinked)} left out: a link is back at that path` : ""
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

/** The arr options shared by the delete confirmation and the rescan of removed links. */
function ArrChoices({ rescan, search, onRescan, onSearch, disabled, rescanFixed = false }: { rescan: boolean; search: boolean; onRescan?: (value: boolean) => void; onSearch: (value: boolean) => void; disabled: boolean; rescanFixed?: boolean }) {
  return (
    <div className="blk-arr-choices">
      {rescanFixed ? null : (
        <label className="checkbox-row">
          <input type="checkbox" checked={rescan} disabled={disabled} onChange={(event) => onRescan?.(event.target.checked)} />
          Ask Radarr/Sonarr to rescan the affected titles
        </label>
      )}
      <label className="checkbox-row">
        <input type="checkbox" checked={search} disabled={disabled} onChange={(event) => onSearch(event.target.checked)} />
        Also search for the removed items
      </label>
      <p className="orv-muted blk-arr-note">
        A rescan makes Radarr or Sonarr see the file as missing. Sonarr's "Unmonitor deleted episodes" and Radarr's "Unmonitor deleted movies" can then unmonitor it. A search removes Radarr's or Sonarr's record of the file, keeps the item monitored and searches for it, so those titles skip the rescan.
      </p>
    </div>
  );
}

/** A cleanup job this page started: its progress, then what happened to each link. */
function CleanupJobStatus({ jobId, job, onDismiss }: { jobId: number; job: JobRecord | null; onDismiss: () => void }) {
  const finished = jobFinished(job);
  const results = useQuery({ queryKey: ["broken-link-results", jobId], queryFn: () => api.brokenLinkCleanupResults(jobId), enabled: finished });
  const progress = recordFromUnknown(job?.progress) ?? {};
  const message = typeof progress.message === "string" ? progress.message : null;
  const notRemoved = (results.data ?? []).filter((record) => record.stage === "skipped" || record.stage === "failed");
  const jobLink = (
    <Link to="/logs" search={{ job: jobId }}>
      Open job #{jobId}
    </Link>
  );
  if (!finished) {
    return (
      <div className="orv-banner orv-banner-progress" role="status">
        <LoaderCircle size={16} className="spin-icon" aria-hidden />
        <div>
          <strong>Deleting broken links, job #{jobId}.</strong> <span>{message ?? "The list refreshes when it finishes."}</span>
        </div>
        {jobLink}
      </div>
    );
  }
  const bad = job?.status === "failed" || job?.status === "partially_failed";
  return (
    <div className={`orv-banner ${bad ? "orv-banner-bad" : "orv-banner-good"}`} role={bad ? "alert" : "status"} data-testid="broken-link-job-result">
      {bad ? <OctagonX size={18} aria-hidden /> : <Check size={16} aria-hidden />}
      <div>
        <strong>{message ?? `Job #${jobId} ${job?.status.replace("_", " ")}.`}</strong>
        {notRemoved.length ? (
          <ul className="blk-result-list" aria-label="Links not removed">
            {notRemoved.slice(0, 50).map((record) => (
              <li key={record.operationId}>
                <span className="orv-name">{fileName(record.linkPath)}</span>: {stageLabels[record.stage]}. {record.message}
              </li>
            ))}
            {notRemoved.length > 50 ? <li>{formatNumber(notRemoved.length - 50)} more in the job log.</li> : null}
          </ul>
        ) : null}
      </div>
      {jobLink}
      <button type="button" className="icon-button orv-banner-close" aria-label="Dismiss" onClick={onDismiss}>
        <X size={16} />
      </button>
    </div>
  );
}

export function BrokenLinkReviewPanel() {
  const queryClient = useQueryClient();
  const review = useQuery({ queryKey: ["broken-links"], queryFn: api.brokenLinks });
  const removed = useQuery({ queryKey: ["broken-links-removed"], queryFn: api.removedBrokenLinks });
  const [view, setView] = useState<BrokenLinkView>("broken");
  const [section, setSection] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  // The rescan is what fixes Sonarr, so it starts on; the search starts off every time the page opens.
  const [rescan, setRescan] = useState(true);
  const [searchAfter, setSearchAfter] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [selectedRemoved, setSelectedRemoved] = useState<Set<number>>(new Set());
  const [searchRemoved, setSearchRemoved] = useState(false);
  const refresh = () => {
    for (const key of ["broken-links", "broken-links-removed", "inventory-summary", "section-summaries", "re-requests", "jobs"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  const job = useQueuedJob(jobId, refresh);
  const jobRunning = jobId !== null && !jobFinished(job.data);
  const remove = useMutation({
    mutationFn: () => api.deleteBrokenLinks({ mediaLinkIds: [...selected], rescan, search: searchAfter }),
    onSuccess: (result) => {
      setJobId(result.jobId);
      setSelected(new Set());
      setConfirming(false);
    }
  });
  const rescanRemoved = useMutation({
    mutationFn: () => api.rescanRemovedBrokenLinks({ operationIds: [...selectedRemoved], search: searchRemoved }),
    onSuccess: () => {
      setSelectedRemoved(new Set());
      void queryClient.invalidateQueries({ queryKey: ["re-requests"] });
    }
  });

  const data = review.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const sections = useMemo(() => brokenLinkSections(items), [items]);
  const filtered = useMemo(() => filterBrokenLinks(items, { section, search }), [items, section, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const groups = useMemo(() => groupBrokenLinks(visible), [visible]);
  const blocked = Boolean(data?.safety.blocked);
  // A rescan of links already removed only needs storage to be up; a jump in the broken count does not matter to it.
  const mountDown = Boolean(data?.safety.mounts.some((check) => !check.mounted));
  const busy = remove.isPending || jobRunning;
  const selectedItems = items.filter((item) => selected.has(item.mediaLinkId));
  const filteredSelected = filtered.filter((item) => selected.has(item.mediaLinkId)).length;
  const removedItems = removed.data ?? [];
  const resetPage = () => setPage(0);
  const selectAllShown = () => {
    setSelected(new Set(filtered.map((item) => item.mediaLinkId)));
    setConfirming(true);
  };
  const notListed = data?.notListed;
  const notListedText = notListed
    ? [
        notListed.targetExists ? `${formatNumber(notListed.targetExists)} have a target again` : "",
        notListed.changed ? `${formatNumber(notListed.changed)} changed since the scan` : "",
        notListed.unchecked ? `${formatNumber(notListed.unchecked)} could not be checked` : ""
      ].filter(Boolean)
    : [];

  return (
    <Panel title="Broken links" icon={<Unlink2 size={18} />} className="orv-panel blk-panel">
      <div className="orv blk">
        {review.isLoading ? <p className="panel-message">Checking broken links...</p> : null}
        {review.error ? <p className="panel-message error">{review.error.message}</p> : null}
        {data?.safety.warnings.map((warning) => (
          <div key={warning} className="orv-banner orv-banner-bad" role="alert">
            <TriangleAlert size={18} aria-hidden />
            <div>
              <strong>Deleting is blocked.</strong> <span>{warning}</span>
            </div>
          </div>
        ))}
        {data && !data.rechecked ? (
          <p className="orv-skipped">These are the last scan's results. They were not checked again, because storage looks down.</p>
        ) : null}
        {jobId !== null ? <CleanupJobStatus jobId={jobId} job={job.data ?? null} onDismiss={() => setJobId(null)} /> : null}

        {data ? (
          <>
            <header className="orv-header">
              <div className="orv-totals">
                <p className="orv-total-line">
                  <strong>{countText(items.length, "broken link")}</strong>
                  <span className="orv-total-sep" aria-hidden>
                    ·
                  </span>
                  <strong>{countText(brokenLinkTitleCount(items), "title")}</strong>
                  <span className="orv-total-label">in the library point at files that are gone</span>
                </p>
                <p className="orv-skipped">
                  {notListedText.length ? `${notListedText.join(", ")}; not listed. ` : ""}
                  {data.lastFullScanAt ? `Last full symlink scan: ${formatDate(data.lastFullScanAt)}.` : "No full symlink scan has finished yet."}
                </p>
              </div>
              <div className="orv-header-actions">
                <button type="button" className="secondary orv-how" aria-expanded={howOpen} aria-controls="blk-how" onClick={() => setHowOpen((value) => !value)}>
                  How this works <ChevronDown size={14} aria-hidden className="orv-chevron" />
                </button>
                <button type="button" className="danger" disabled={busy || blocked || filtered.length === 0 || view !== "broken"} onClick={selectAllShown}>
                  <Trash2 size={15} /> Delete all shown ({formatNumber(filtered.length)})
                </button>
              </div>
            </header>
            {howOpen ? (
              <div className="orv-how-panel" id="blk-how">
                <ul>
                  <li>
                    <strong>What is listed:</strong> library symlinks whose target was gone at the last scan, checked again on disk when the page loads. Sonarr stops its whole rescan of a series when it meets one of these, so it keeps showing the episode as present and never searches for it.
                  </li>
                  <li>
                    <strong>What a delete does:</strong> removes only the symlink in the library, never a file on storage. Right before each one, SRTL checks that it is still a symlink, still points at the recorded target, that the target is still gone, and that its storage is still mounted. A link that changed is skipped and reported.
                  </li>
                  <li>
                    <strong>Radarr and Sonarr:</strong> after the delete, each affected movie or series gets one rescan, so Radarr or Sonarr shows the file as missing. The Removed tab can ask again later.
                  </li>
                  <li>
                    <strong>When deleting is blocked:</strong> {data.safety.rule}
                  </li>
                  <li>
                    <strong>Not listed here:</strong> links whose target exists but could not be read. They are not broken, so they are never deleted from this page.
                  </li>
                </ul>
              </div>
            ) : null}
            <SettingsTabs
              label="Broken link sections"
              idPrefix="blk"
              className="orv-views"
              active={view}
              onSelect={setView}
              tabs={[
                { key: "broken", label: <>Broken links <span className="orv-tab-count">{formatNumber(items.length)}</span></> },
                { key: "removed", label: <>Removed, last 30 days <span className="orv-tab-count">{formatNumber(removedItems.length)}</span></> }
              ]}
            />

            {view === "broken" ? (
              <div role="tabpanel" id="blk-panel-broken" aria-labelledby="blk-tab-broken" className="orv-view">
                <div className="orv-filters">
                  <label className="orv-search">
                    <Search size={15} aria-hidden />
                    <input type="search" aria-label="Search broken links" placeholder="Search titles and paths" value={search} onChange={(event) => { setSearch(event.target.value); resetPage(); }} />
                  </label>
                  <select aria-label="Filter by library folder" value={section} onChange={(event) => { setSection(event.target.value); resetPage(); }}>
                    <option value="all">All folders</option>
                    {sections.map((entry) => (
                      <option key={entry.section} value={entry.section}>
                        {entry.sectionTitle} ({formatNumber(entry.count)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="orv-table-bar">
                  <label className="orv-select-all">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filteredSelected === filtered.length}
                      disabled={busy || blocked || filtered.length === 0}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelected((current) => {
                          const next = new Set(current);
                          for (const item of filtered) {
                            if (checked) next.add(item.mediaLinkId);
                            else next.delete(item.mediaLinkId);
                          }
                          return next;
                        });
                        setConfirming(false);
                      }}
                    />
                    <span>Select all {formatNumber(filtered.length)} shown</span>
                  </label>
                  <Pager page={currentPage} pageCount={pageCount} total={filtered.length} onPage={setPage} />
                </div>
                {filtered.length === 0 ? (
                  <p className="orv-empty">{items.length ? "No broken links match these filters." : "No broken links. Every library symlink pointed at a file at the last scan."}</p>
                ) : (
                  <div className="orv-table-wrap">
                    <table className="orv-table blk-table" aria-label="Broken links">
                      <thead>
                        <tr>
                          <th className="orv-col-check">
                            <span className="sr-only">Select</span>
                          </th>
                          <th>Link</th>
                          <th>Target</th>
                          <th className="orv-col-date">Broken since</th>
                        </tr>
                      </thead>
                      {groups.map((group) => (
                        <tbody key={group.section}>
                          <tr className="blk-section-row">
                            <th colSpan={4} scope="rowgroup">
                              {group.sectionTitle}
                            </th>
                          </tr>
                          {group.titles.flatMap((title) => [
                            <tr key={title.key} className="blk-title-row">
                              <th colSpan={4} scope="rowgroup">
                                {title.itemName} <span className="orv-muted">({countText(title.links.length, "link")})</span>
                              </th>
                            </tr>,
                            ...title.links.map((item) => <BrokenLinkRow key={item.mediaLinkId} item={item} checked={selected.has(item.mediaLinkId)} disabled={busy || blocked} onChange={(checked) => { setSelected((current) => toggleIn(current, item.mediaLinkId, checked)); setConfirming(false); }} />)
                          ])}
                        </tbody>
                      ))}
                    </table>
                  </div>
                )}
                {pageCount > 1 ? (
                  <div className="orv-table-bar orv-table-bar-end">
                    <Pager page={currentPage} pageCount={pageCount} total={filtered.length} onPage={setPage} />
                  </div>
                ) : null}
              </div>
            ) : (
              <div role="tabpanel" id="blk-panel-removed" aria-labelledby="blk-tab-removed" className="orv-view">
                <p className="orv-hint">
                  Links removed here in the last 30 days. Ask Radarr or Sonarr to rescan their titles again, for example after an instance was paused. A rescan while the broken link is still there fails in Sonarr, so links still listed as broken are not offered here.
                </p>
                {removed.error ? <p className="panel-message error">{removed.error.message}</p> : null}
                {removedItems.length === 0 ? (
                  <p className="orv-empty">No broken links were removed in the last 30 days.</p>
                ) : (
                  <>
                    <div className="orv-table-bar">
                      <label className="orv-select-all">
                        <input type="checkbox" checked={removedItems.length > 0 && removedItems.every((record) => selectedRemoved.has(record.operationId))} disabled={rescanRemoved.isPending} onChange={(event) => setSelectedRemoved(event.target.checked ? new Set(removedItems.map((record) => record.operationId)) : new Set())} />
                        <span>Select all {formatNumber(removedItems.length)}</span>
                      </label>
                    </div>
                    <div className="orv-table-wrap">
                      <table className="orv-table" aria-label="Removed broken links">
                        <thead>
                          <tr>
                            <th className="orv-col-check">
                              <span className="sr-only">Select</span>
                            </th>
                            <th>Link</th>
                            <th>Title</th>
                            <th className="orv-col-date">Removed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {removedItems.map((record) => (
                            <tr key={record.operationId} className={selectedRemoved.has(record.operationId) ? "is-selected" : undefined}>
                              <td className="orv-col-check">
                                <input type="checkbox" aria-label={`Select removed ${fileName(record.linkPath)}`} checked={selectedRemoved.has(record.operationId)} disabled={rescanRemoved.isPending} onChange={(event) => setSelectedRemoved((current) => toggleIn(current, record.operationId, event.target.checked))} />
                              </td>
                              <td className="orv-col-file">
                                <div className="orv-name-line">
                                  <span className="orv-name">{fileName(record.linkPath)}</span>
                                </div>
                                <div className="orv-sub">
                                  <span className="orv-dir" title={record.linkPath}>{record.linkPath}</span>
                                </div>
                              </td>
                              <td>{record.itemName}</td>
                              <td className="orv-col-date">
                                {record.completedAt ? formatDate(record.completedAt) : "-"}{" "}
                                <Link to="/logs" search={{ job: record.jobId }}>
                                  #{record.jobId}
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="blk-removed-actions">
                      <ArrChoices rescan search={searchRemoved} onSearch={setSearchRemoved} disabled={rescanRemoved.isPending} rescanFixed />
                      <button type="button" className="orv-primary" disabled={rescanRemoved.isPending || selectedRemoved.size === 0 || mountDown} onClick={() => rescanRemoved.mutate()}>
                        {rescanRemoved.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <RefreshCw size={16} />} Ask Radarr/Sonarr to rescan{selectedRemoved.size ? ` (${formatNumber(selectedRemoved.size)})` : ""}
                      </button>
                    </div>
                  </>
                )}
                {rescanRemoved.data ? (
                  <div className="orv-banner orv-banner-good" role="status">
                    <Check size={16} aria-hidden />
                    <div>
                      <strong>{rescanResultText(rescanRemoved.data)}</strong>
                      {rescanRemoved.data.problems.length ? (
                        <ul className="blk-result-list" aria-label="Titles not sent">
                          {rescanRemoved.data.problems.map((problem) => (
                            <li key={`${problem.title}-${problem.reason}`}>
                              {problem.title}: {problem.reason}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <span className="orv-banner-detail">Radarr and Sonarr are sent these at the usual re-request pace; Activity shows each one.</span>
                    </div>
                  </div>
                ) : null}
                {rescanRemoved.error ? <p className="panel-message error" role="alert">{rescanRemoved.error.message}</p> : null}
              </div>
            )}

            {remove.error ? (
              <div className="orv-banner orv-banner-bad" role="alert">
                <OctagonX size={18} aria-hidden />
                <div>{remove.error.message}</div>
              </div>
            ) : null}

            {selected.size > 0 && view === "broken" ? (
              <div className="orv-action-bar is-delete" role="region" aria-label="Selected broken links">
                {confirming ? (
                  <div className="orv-confirm" role="group" aria-label="Confirm broken link delete">
                    <p className="orv-confirm-question">
                      Delete <strong>{countText(selectedItems.length, "broken symlink")}</strong> in {countText(brokenLinkTitleCount(selectedItems), "title")}? Only the links are removed; no file on storage is touched. A link that changed since the scan is skipped.
                    </p>
                    <ArrChoices rescan={rescan} search={searchAfter} onRescan={setRescan} onSearch={setSearchAfter} disabled={busy} />
                    <div className="orv-confirm-actions">
                      <button type="button" className="orv-danger-solid" disabled={busy || blocked} onClick={() => remove.mutate()}>
                        {remove.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />} Delete {countText(selectedItems.length, "link")}
                      </button>
                      <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                        <X size={16} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="orv-action-row">
                  <p className="orv-action-count" aria-live="polite">
                    <strong>{countText(selected.size, "link")}</strong> selected
                  </p>
                  <div className="orv-action-buttons">
                    <button type="button" className="secondary" disabled={busy} onClick={() => { setSelected(new Set()); setConfirming(false); }}>
                      Clear
                    </button>
                    <button type="button" className="orv-danger-solid" disabled={busy || blocked || confirming} onClick={() => setConfirming(true)}>
                      <Trash2 size={16} /> Delete selected
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function BrokenLinkRow({ item, checked, disabled, onChange }: { item: BrokenLinkItem; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <tr className={checked ? "is-selected" : undefined}>
      <td className="orv-col-check">
        <input type="checkbox" aria-label={`Select ${fileName(item.linkPath)}`} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      </td>
      <td className="orv-col-file">
        <div className="orv-name-line">
          <span className="orv-name">{fileName(item.linkPath)}</span>
        </div>
        <div className="orv-sub">
          <span className="orv-dir" title={item.linkPath}>{item.linkPath}</span>
        </div>
      </td>
      <td className="orv-col-file">
        <div className="orv-sub">
          <span className="orv-dir" title={item.targetPath}>{item.targetPath}</span>
        </div>
        <div className="orv-sub orv-muted">On {rootNames[item.targetRoot]}</div>
      </td>
      <td className="orv-col-date" title={item.brokenSince ? formatDate(item.brokenSince) : "Broken before SRTL recorded when"}>
        {item.brokenSince ? formatDate(item.brokenSince) : "Unknown"}
      </td>
    </tr>
  );
}

function Pager({ page, pageCount, total, onPage }: { page: number; pageCount: number; total: number; onPage: (page: number) => void }) {
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
