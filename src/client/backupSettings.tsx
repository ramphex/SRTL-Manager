import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, DatabaseBackup, Play, ShieldAlert, TriangleAlert } from "lucide-react";
import { defaultBackupSettings, maximumKeptBackups, minimumVerifiedBackups, type BackupEntry, type BackupRunSummary, type BackupSettings, type BackupState } from "../shared/backups";
import { api } from "./api";
import { Panel } from "./App";
import { formatBytes, formatDate, formatNumber, useUserPreferences } from "./appShared";

const backupsKey = ["backups"] as const;
const restoreGuideUrl = "https://github.com/ramphex/SRTL-Manager/blob/main/docs/backups.md#restoring-a-backup";

function backupAgeLabel(createdAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const runStatusLabels: Record<BackupRunSummary["status"], string> = {
  completed: "Verified",
  partially_failed: "Partly failed",
  failed: "Failed",
  cancelled: "Cancelled"
};

function sameSettings(left: BackupSettings, right: BackupSettings): boolean {
  return left.enabled === right.enabled && left.time === right.time && left.keep === right.keep && left.location === right.location;
}

function BackupList({ backups, timeFormat }: { backups: BackupEntry[]; timeFormat: ReturnType<typeof useUserPreferences>["timeFormat"] }) {
  if (backups.length === 0) return <p className="section-settings-help">No backups at this location yet.</p>;
  return (
    <div className="backup-table-scroll">
      <table aria-label="Existing backups">
        <thead>
          <tr>
            <th scope="col">Backup</th>
            <th scope="col">Age</th>
            <th scope="col">Size</th>
            <th scope="col">Verified</th>
          </tr>
        </thead>
        <tbody>
          {backups.map((backup) => (
            <tr key={backup.name}>
              <td>
                <span className="backup-name">{backup.name}</span>
                <small>{formatDate(backup.createdAt, timeFormat)}{backup.appVersion ? ` · app ${backup.appVersion}` : ""}{backup.migration ? ` · migration ${backup.migration}` : ""}</small>
              </td>
              <td>{backupAgeLabel(backup.createdAt)}</td>
              <td>{formatBytes(backup.sizeBytes)}</td>
              <td>
                {backup.verified
                  ? <span className="pill pill-info">Verified</span>
                  : <span className="pill pill-warning" title={backup.problem ?? undefined}>Not verified</span>}
                {backup.problem ? <small>{backup.problem}</small> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BackupSettingsPanel() {
  const queryClient = useQueryClient();
  const { timeFormat } = useUserPreferences();
  const backups = useQuery({
    queryKey: backupsKey,
    queryFn: api.backups,
    // Quick while a job runs or the worker has yet to look at a newly saved location.
    refetchInterval: (query) => (query.state.data && query.state.data.activeJobId == null && query.state.data.status ? 30_000 : 3_000)
  });
  const state = backups.data;
  const [draft, setDraft] = useState<BackupSettings>(defaultBackupSettings);
  const [message, setMessage] = useState<string | null>(null);
  const saved = state?.settings;
  // Query results keep their identity while unchanged, so polling never overwrites an edit in progress.
  useEffect(() => {
    if (saved) setDraft({ ...saved });
  }, [saved]);
  const save = useMutation({
    mutationFn: () => api.saveBackupSettings(draft),
    onSuccess: (next) => {
      queryClient.setQueryData<BackupState>(backupsKey, next);
      setMessage("Backup settings saved.");
    }
  });
  const run = useMutation({
    mutationFn: api.runBackup,
    onSuccess: (result) => {
      setMessage(`Backup job #${result.jobId} queued. Follow it in Logs.`);
      void queryClient.invalidateQueries({ queryKey: backupsKey });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });
  const dirty = saved ? !sameSettings(draft, saved) : false;
  const keepValid = Number.isInteger(draft.keep) && draft.keep >= minimumVerifiedBackups && draft.keep <= maximumKeptBackups;
  const status = state?.status ?? null;
  const problem = state?.locationRefusal ?? status?.problem ?? null;
  const update = (patch: Partial<BackupSettings>) => {
    setMessage(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <Panel
      title="Database backups"
      icon={<DatabaseBackup size={18} />}
      actions={
        <button type="button" onClick={() => { setMessage(null); run.mutate(); }} disabled={!state || state.activeJobId != null || run.isPending}>
          <Play size={16} />
          {state?.activeJobId != null ? "Backup running..." : "Back up now"}
        </button>
      }
    >
      <div className="advanced-settings">
        {backups.error ? <p className="panel-message action-error" role="alert">{backups.error.message}</p> : null}
        {run.error ? <p className="panel-message action-error" role="alert">{run.error.message}</p> : null}
        {state?.alert ? (
          <p className="verification-disabled-warning backup-alert" role="alert">
            <TriangleAlert size={15} aria-hidden="true" /> <span>{state.alert.message}</span>
          </p>
        ) : null}

        <section className="advanced-settings-section" aria-labelledby="backup-status-title">
          <div className="advanced-settings-heading">
            <div>
              <h3 id="backup-status-title">Status</h3>
              <p>Runs appear in Logs with the rest of the job history.</p>
            </div>
            <span className={`pill ${state?.alert ? "pill-warning" : "pill-info"}`}>{!state ? "Checking" : state.alert ? "Needs attention" : state.settings.enabled ? "Scheduled" : "Off"}</span>
          </div>
          <dl className="backup-status-list">
            <div>
              <dt>Last run</dt>
              <dd>
                {state?.lastRun ? <>
                  {runStatusLabels[state.lastRun.status]} · {formatDate(state.lastRun.finishedAt, timeFormat)} · job #{state.lastRun.jobId}
                  {state.alert?.kind === "failed" ? null : <small>{state.lastRun.message}</small>}
                </> : "None yet"}
              </dd>
            </div>
            <div>
              <dt>Next run</dt>
              <dd>
                {state?.nextRunAt ? formatDate(state.nextRunAt, timeFormat) : "Off"}
                {state?.settings.enabled ? <small>{state.settings.time} server time ({state.timeZone})</small> : null}
              </dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>
                <span className="backup-name">{status?.directory ?? state?.location ?? ""}</span>
                <small>
                  {problem ? "Not usable" : status ? `Writable${status.freeBytes != null ? `, ${formatBytes(status.freeBytes)} free` : ""}` : "Waiting for the worker to check this location"}
                </small>
              </dd>
            </div>
          </dl>
          {problem && problem !== state?.alert?.message ? <p className="panel-message action-error" role="alert">{problem}</p> : null}
          {status?.permissionsWarning ? <p className="verification-disabled-warning">{status.permissionsWarning}</p> : null}
        </section>

        <section className="advanced-settings-section" aria-labelledby="backup-schedule-title">
          <div className="advanced-settings-heading">
            <div>
              <h3 id="backup-schedule-title">Schedule</h3>
              <p>A new backup must pass verification before older ones are removed.</p>
            </div>
          </div>
          <div className="advanced-settings-grid">
            <label className="advanced-toggle">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
              <span>
                <strong>Back up the database every day</strong>
                <small>Back up now works whether or not this is on.</small>
              </span>
            </label>
            <label className="advanced-field">
              <span>Start time (server time)</span>
              <input type="time" value={draft.time} disabled={!draft.enabled} required onChange={(event) => update({ time: event.target.value })} />
            </label>
            <label className="advanced-field">
              <span>Backups to keep</span>
              <input type="number" min={minimumVerifiedBackups} max={maximumKeptBackups} step={1} value={Number.isNaN(draft.keep) ? "" : draft.keep} onChange={(event) => update({ keep: event.target.valueAsNumber })} />
              <small>At least {minimumVerifiedBackups} verified backups always stay.</small>
            </label>
            <label className="advanced-field">
              <span>Backup location</span>
              <input
                type="text"
                value={draft.location ?? ""}
                placeholder={state?.defaultLocation ?? ""}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => update({ location: event.target.value.trim() ? event.target.value : null })}
              />
              <small>A folder the worker can write, outside your library. Empty uses the default shown. Backups already saved elsewhere stay where they are.</small>
            </label>
          </div>
          <div className="advanced-settings-actions">
            {message ? <span className="success" role="status">{message}</span> : null}
            {save.error ? <span className="error" role="alert">{save.error.message}</span> : null}
            {!keepValid ? <span className="error" role="alert">Keep between {minimumVerifiedBackups} and {formatNumber(maximumKeptBackups)} backups.</span> : null}
            <button type="button" onClick={() => { setMessage(null); save.mutate(); }} disabled={!dirty || !keepValid || !draft.time || save.isPending}>
              <CheckCircle2 size={16} />
              Save backup settings
            </button>
          </div>
        </section>

        <section className="advanced-settings-section" aria-labelledby="backup-list-title">
          <div className="advanced-settings-heading">
            <div>
              <h3 id="backup-list-title">Existing backups</h3>
              <p>Each one is a dump, a SHA-256 file and a manifest.</p>
            </div>
          </div>
          <BackupList backups={status?.backups ?? []} timeFormat={timeFormat} />
        </section>

        <section className="advanced-settings-section" aria-labelledby="backup-restore-title">
          <div className="advanced-settings-heading">
            <div>
              <h3 id="backup-restore-title"><ShieldAlert size={15} aria-hidden="true" /> Keep these safe</h3>
            </div>
          </div>
          <p className="section-settings-help">
            Dumps contain password hashes and encrypted keys, so treat them like passwords. Copy them to another machine too: a backup on the same disk as the database does not survive that disk.
          </p>
          <p className="section-settings-help">
            Saved Plex tokens and Jellyfin, Radarr and Sonarr API keys can only be read with the <code>SRTL_SECRET_KEY</code> this install uses. A backup does not include it, so keep a copy of the key somewhere separate. Without it, those credentials must be entered again after a restore.
          </p>
          <p className="section-settings-help">
            Restoring replaces the whole database, so it is done by hand. Follow the <a href={restoreGuideUrl} target="_blank" rel="noreferrer">restore guide</a>.
          </p>
        </section>
      </div>
    </Panel>
  );
}

/** Shows a failed or overdue backup on every page, because nobody opens this settings page to find out. */
export function BackupAlertBanner() {
  const backups = useQuery({ queryKey: backupsKey, queryFn: api.backups, refetchInterval: 60_000, retry: false });
  const alert = backups.data?.alert;
  if (!alert) return null;
  return (
    <p className="backup-alert-bar" role="status">
      <TriangleAlert size={15} aria-hidden="true" />
      <span><strong>Database backups need attention.</strong> {alert.message}</span>
      <Link to="/settings/backups">Open backup settings</Link>
    </p>
  );
}
