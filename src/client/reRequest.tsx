import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { ReRequestPreview, ReRequestRecord, ReRequestStatus } from "../shared/reRequests";
import { api } from "./api";
import { formatDate, formatNumber } from "./appShared";

const previewIdLimit = 50_000;

const statusLabels: Record<ReRequestStatus, string> = {
  queued: "Matching",
  pending: "Waiting its turn",
  requested: "Search sent",
  failed: "Failed",
  unmatched: "No match",
  skipped: "Not requested"
};

function filesText(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? "file" : "files"}`;
}

function PreviewSummary({ preview }: { preview: ReRequestPreview }) {
  const where = preview.instances.map((entry) => `${formatNumber(entry.count)} in ${entry.instanceName}`).join(", ");
  return (
    <div className="re-request-preview" data-testid="re-request-preview">
      <p>
        {preview.eligibleCount > 0
          ? `${formatNumber(preview.eligibleCount)} of ${filesText(preview.total)} can be re-requested: ${where}.`
          : `None of these ${filesText(preview.total)} can be re-requested.`}
      </p>
      {preview.ineligible.length > 0 ? (
        <ul>
          {preview.ineligible.map((group) => (
            <li key={group.reason}>
              <strong>{group.reason}</strong> {filesText(group.count)} would be deleted without a search: {group.examples.join(", ")}
              {group.count > group.examples.length ? `, and ${formatNumber(group.count - group.examples.length)} more` : ""}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const reRequestOptionLabel = "Also ask Radarr or Sonarr to search for a new copy";
export const reRequestExplanation = "After a file is deleted, SRTL clears it from Radarr or Sonarr, monitors that movie or those episodes, and asks for a search. Searches are paced. Tags are not changed, and a failed search never undoes the delete.";

/** Which of these files Radarr or Sonarr can re-request, looked up only once the option is on. */
export function ReRequestPreviewCheck({ storageFileIds, enabled }: { storageFileIds: number[]; enabled: boolean }) {
  const ids = storageFileIds.slice(0, previewIdLimit);
  const preview = useQuery({
    queryKey: ["re-request-preview", ids],
    queryFn: () => api.previewReRequests(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 15_000
  });
  if (!enabled || ids.length === 0) return null;
  if (preview.isLoading) return <p className="muted">Checking which files can be re-requested...</p>;
  if (preview.error) return <p className="panel-message error" role="alert">{preview.error.message}</p>;
  return preview.data ? <PreviewSummary preview={preview.data} /> : null;
}

/** The per-delete choice. Off until someone ticks it, and it says which files it cannot help before anything is deleted. */
export function ReRequestOption({ storageFileIds, checked, onChange, disabled = false }: { storageFileIds: number[]; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div className="re-request-option">
      <label className="checkbox-row">
        <input type="checkbox" checked={checked} disabled={disabled || storageFileIds.length === 0} onChange={(event) => onChange(event.target.checked)} />
        <span>{reRequestOptionLabel}</span>
      </label>
      <p className="muted">{reRequestExplanation}</p>
      <ReRequestPreviewCheck storageFileIds={storageFileIds} enabled={checked} />
    </div>
  );
}

function ReRequestRow({ item, busy, onRetry }: { item: ReRequestRecord; busy: boolean; onRetry: (id: number) => void }) {
  return (
    <tr>
      <td>
        <strong>{item.title ?? item.displayName}</strong>
        {item.episodes ? ` ${item.episodes}` : ""}
        <span className="orphan-path">{item.displayName}</span>
      </td>
      <td>{item.instanceName ?? "-"}</td>
      <td>
        <span data-status={item.status}>{statusLabels[item.status]}</span>
        {item.message ? <span className={item.status === "failed" ? "orphan-protected re-request-error" : "orphan-path"}>{item.message}</span> : null}
        {item.previousMonitored === false && item.status === "requested" ? <span className="orphan-path">Was unmonitored; monitored now.</span> : null}
      </td>
      <td className="orphan-nowrap">{formatDate(item.requestedAt ?? item.createdAt)}</td>
      <td>
        <Link to="/logs" search={{ job: item.jobId }}>#{item.jobId}</Link>
      </td>
      <td>
        {item.status === "failed" ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => onRetry(item.id)}>
            <RotateCcw size={14} /> Retry
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/** What was asked of Radarr and Sonarr, so a failure stays visible after the delete job is long gone. */
export function ReRequestActivity() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["re-requests"],
    queryFn: api.reRequests,
    refetchInterval: (query) => ((query.state.data?.counts.queued ?? 0) + (query.state.data?.counts.pending ?? 0) > 0 ? 5_000 : 30_000)
  });
  const retry = useMutation({
    mutationFn: (ids: number[] | "all_failed") => api.retryReRequests(ids),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["re-requests"] })
  });
  if (!list.data?.items.length) return list.error ? <p className="panel-message error">{list.error.message}</p> : null;
  const { counts, items, perMinute } = list.data;
  const waiting = counts.queued + counts.pending;
  return (
    <section className="re-request-activity" aria-labelledby="re-request-activity-heading">
      <h3 id="re-request-activity-heading">Re-requests</h3>
      <p className="muted">
        {formatNumber(counts.requested)} sent, {formatNumber(waiting)} waiting, {formatNumber(counts.failed)} failed. Up to {formatNumber(perMinute)} a minute for each Radarr or Sonarr instance. "Search sent" means the search started, not that a copy was found.
      </p>
      {counts.failed > 0 ? (
        <div className="orphan-toolbar">
          <button type="button" className="secondary" disabled={retry.isPending} onClick={() => retry.mutate("all_failed")}>
            {retry.isPending ? <LoaderCircle size={14} className="spin-icon" /> : <RotateCcw size={14} />} Retry all failed ({formatNumber(counts.failed)})
          </button>
        </div>
      ) : null}
      {retry.error ? <p className="panel-message error" role="alert">{retry.error.message}</p> : null}
      <div className="orphan-table-scroll" tabIndex={0} aria-label="Recent re-requests">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Instance</th>
              <th>Result</th>
              <th>When</th>
              <th>Job</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ReRequestRow key={item.id} item={item} busy={retry.isPending} onRetry={(id) => retry.mutate([id])} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
