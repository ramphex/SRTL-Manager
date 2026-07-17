import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Copy, File, FileText, Folder, Info, ListChecks, OctagonX, Play, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "./api";
import { defaultAdvancedSettings, normalizeAdvancedSettings } from "../shared/advancedSettings";
import { eventDataChips, formatEventLevel, formatJobType, formatLogData, hasLogData, jobProgressChips } from "./logDisplay";
import { auditOptionsFromJob, copyOptionsFromJob, scanOptionsFromJob } from "./jobScopeLocks";
import { jobEventCountLabel } from "./jobEvents";
import { normalizeRecentJobsCompletedWindowMinutes, recentJobsCompletedWindowOptions, visibleDashboardJobs } from "./recentJobs";
import { type AuditMode, type AuditResultRecord, type AuditRunRecord, type CopyConflictPreview, type JobEventRecord, type JobRecord, type CopyLocalConflictStrategy, type MediaLinkRow, type TimeFormatPreference } from "../shared/types";
import { JobStatusTerminateAction, LogChipList, Panel, ScanProgressPanel, StatusPill, TerminateJobDialog } from "./App";
import { AuditPrompt, AuditStatusPrompt, canTerminateJob, copyElapsedLabel, CopyPrompt, finiteNumberFromUnknown, formatBytes, formatDate, formatNumber, formatTime, invalidateCopyJobData, recordFromUnknown, scanAgeLabel, ScanStatusPrompt, sectionDisplayTitle, storageLocationName, useJobEventTimeline, useStartCopyJob, useStorageLocations, useTerminateJobMutation, useUserPreferences } from "./appShared";
import { auditProgressFromJob, auditProgressPercent, auditStageLabel, auditStatusDetail, basenameFromPath, copyCompletedCount, copyCurrentItem, copyEventChips, copyFailedItemSummaries, copyOverallProgressPercent, copyProgressFromJob, copyRemainingLabel, copyStageLabel, copyStagePercent, copySymlinkedCount, copyThroughputLabel, copyTransferSpeedLabel, copyTransferSpeedSecondaryLabel, formatAuditScope, formatCopyScope, formatScopedFolderParts, formatTitleScanJobDetail, jobDurationLabel, scanFolderScopeParts, scanScopeLabels, selectedLinkIdsFromJobs, selectedLinkTitleSummaries } from "./jobPresentationUtils";
function JobEventsHeader({
  label,
  jobId,
  loaded,
  total,
  loading,
  loadingOlder
}: {
  label: string;
  jobId: number | null;
  loaded: number;
  total: number;
  loading: boolean;
  loadingOlder: boolean;
}) {
  return (
    <div className="audit-dialog-section-title">
      <span className="audit-dialog-section-label">
        <FileText size={15} />
        <span>{label}</span>
      </span>
      {jobId ? (
        <span className="job-events-heading-actions">
          <small>{loading ? "Loading events..." : loadingOlder ? `Loading ${jobEventCountLabel(loaded, total)}` : jobEventCountLabel(loaded, total)}</small>
          <Link to="/logs" search={{ job: jobId }} className="secondary job-events-full-link">
            <FileText size={13} />
            See full events
          </Link>
        </span>
      ) : null}
    </div>
  );
}

export function AuditDialog({
  prompt,
  onClose
}: {
  prompt: AuditPrompt | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { timeFormat, autoOpenTaskStatus } = useUserPreferences();
  const [jobId, setJobId] = useState<number | null>(null);
  const [selectedMode, setSelectedMode] = useState<AuditMode | null>(null);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const advancedSettings = useQuery({
    queryKey: ["advanced-settings"],
    queryFn: api.getAdvancedSettings,
    enabled: Boolean(prompt)
  });
  const advanced = normalizeAdvancedSettings(advancedSettings.data ?? defaultAdvancedSettings);
  const defaultAuditMode = advanced.audit.defaultMode;
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: 1500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 1500 : false, loadAll: true });
  const startAudit = useMutation({
    mutationFn: ({ auditPrompt, mode }: { auditPrompt: AuditPrompt; mode: AuditMode }) =>
      api.startAudit({
        mode,
        ...(advanced.audit.byteCompareWhenSourceKnown ? {} : { byteCompare: false }),
        ...auditPrompt.options
      }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      if (autoOpenTaskStatus) {
        setJobId(result.jobId);
        setSelectedMode(variables.mode);
      } else {
        onClose();
      }
    }
  });

  useEffect(() => {
    setJobId(null);
    setSelectedMode(null);
  }, [prompt]);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const canStart = !jobId && !startAudit.isPending;
  const highlightedMode = selectedMode ?? (!jobId ? defaultAuditMode : null);

  function queueAudit(mode: AuditMode) {
    if (!canStart || !prompt) return;
    startAudit.mutate({ auditPrompt: prompt, mode });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Audit</span>
            <h2 id="audit-dialog-title">{prompt.title}</h2>
            <p>{prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close audit window" onClose={onClose} />
        </div>

        <div className="audit-mode-grid" role="group" aria-label="Audit mode">
          <button type="button" className={`audit-mode-card${highlightedMode === "fast" ? " selected" : ""}`} onClick={() => queueAudit("fast")} disabled={!canStart}>
            <Play size={17} />
            <span>
              <strong>Fast Audit</strong>
              <small>Read container streams without a full decode.</small>
              {!jobId && defaultAuditMode === "fast" ? <em>Default</em> : null}
            </span>
          </button>
          <button type="button" className={`audit-mode-card${highlightedMode === "deep" ? " selected" : ""}`} onClick={() => queueAudit("deep")} disabled={!canStart}>
            <Activity size={17} />
            <span>
              <strong>Deep Audit</strong>
              <small>Decode media fully for stricter validation.</small>
              {!jobId && defaultAuditMode === "deep" ? <em>Default</em> : null}
            </span>
          </button>
        </div>

        {startAudit.error ? <p className="panel-message action-error">{startAudit.error.message}</p> : null}
        {advancedSettings.error ? <p className="panel-message action-error">{advancedSettings.error.message}</p> : null}

        <AuditProgressPanel job={currentJob} pendingJobId={jobId} />

        <div className="audit-dialog-events">
          <JobEventsHeader label="Progress events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading audit events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {!jobId ? <p className="panel-message">Pick a mode to start the audit. Closing this window after start leaves the job running in the background.</p> : null}
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

export function CopyDialog({
  prompt,
  onClose
}: {
  prompt: CopyPrompt | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { timeFormat } = useUserPreferences();
  const [jobId, setJobId] = useState<number | null>(prompt?.jobId ?? null);
  const [startedPromptKey, setStartedPromptKey] = useState<string | null>(null);
  const [localConflictStrategy, setLocalConflictStrategy] = useState<CopyLocalConflictStrategy | null>(null);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const currentJobId = currentJob?.id ?? null;
  const currentJobStatus = currentJob?.status ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });
  const startCopy = useStartCopyJob((result) => setJobId(result.jobId));

  useEffect(() => {
    setJobId(prompt?.jobId ?? null);
    setStartedPromptKey(null);
    setLocalConflictStrategy(null);
  }, [prompt?.key, prompt?.jobId]);

  useEffect(() => {
    if (!prompt?.autoStart || !prompt.options || jobId || startedPromptKey === prompt.key || startCopy.isPending) return;
    const requiresLocalResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options.localConflictStrategy && !localConflictStrategy);
    if (requiresLocalResolution) return;
    const options = localConflictStrategy ? { ...prompt.options, localConflictStrategy } : prompt.options;
    const resolvedPromptKey = localConflictStrategy ? `${prompt.key}:${localConflictStrategy}` : prompt.key;
    if (startedPromptKey === resolvedPromptKey) return;
    setStartedPromptKey(resolvedPromptKey);
    startCopy.mutate({ ...prompt, key: resolvedPromptKey, options });
  }, [jobId, localConflictStrategy, prompt, startCopy, startedPromptKey]);

  useEffect(() => {
    if (!currentJobId || currentJobStatus === "queued" || currentJobStatus === "running") return;
    invalidateCopyJobData(queryClient);
  }, [currentJobId, currentJobStatus, queryClient]);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const needsLocalConflictResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options?.localConflictStrategy && !localConflictStrategy && !jobId);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="copy-dialog-title">{prompt.title}</h2>
            <p>{jobId ? `Job #${jobId} - ${prompt.description}` : prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close copy window" onClose={onClose} />
        </div>

        {startCopy.error ? <p className="panel-message action-error">{startCopy.error.message}</p> : null}

        {needsLocalConflictResolution && prompt.conflicts ? (
          <CopyConflictResolution conflicts={prompt.conflicts} onKeepBoth={() => setLocalConflictStrategy("keep_both")} onReplace={() => setLocalConflictStrategy("replace")} />
        ) : (
          <CopyProgressPanel
            job={currentJob}
            pendingJobId={jobId}
            isStarting={startCopy.isPending}
            failedEvents={events.events}
            failedEventsLoading={events.isLoading || events.isFetchingNextPage}
            failedEventsError={events.error?.message}
          />
        )}

        <div className="audit-dialog-events">
          <JobEventsHeader label="Copy events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading copy events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {!jobId && !startCopy.error && !needsLocalConflictResolution ? <p className="panel-message">Starting the copy job. Closing this window after start leaves the job running in the background.</p> : null}
          {needsLocalConflictResolution ? <p className="panel-message">Choose how to handle the existing local file before starting this copy.</p> : null}
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <CopyLogEventRow key={event.id} event={event} timeFormat={timeFormat} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

function CopyConflictResolution({
  conflicts,
  onKeepBoth,
  onReplace
}: {
  conflicts: CopyConflictPreview;
  onKeepBoth: () => void;
  onReplace: () => void;
}) {
  return (
    <div className="copy-conflict-panel">
      <div className="copy-conflict-header">
        <TriangleAlert size={18} />
        <span>
          <strong>Existing local files found</strong>
          <small>
            {formatNumber(conflicts.totalCandidates)} local file{conflicts.totalCandidates === 1 ? "" : "s"} across {formatNumber(conflicts.totalConflicts)} copy item
            {conflicts.totalConflicts === 1 ? "" : "s"}
          </small>
        </span>
      </div>
      <div className="copy-conflict-list">
        {conflicts.conflicts.map((conflict) => (
          <div key={`${conflict.linkId}:${conflict.destinationPath}`} className="copy-conflict-item">
            <strong>{conflict.itemName}</strong>
            <small>{conflict.relativePath}</small>
            <ul>
              {conflict.candidates.map((candidate) => (
                <li key={candidate.filePath}>
                  <span>{candidate.relativePath}</span>
                  <small>{formatBytes(candidate.sizeBytes)}</small>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="copy-conflict-actions">
        <button type="button" className="secondary" onClick={onKeepBoth}>
          <Copy size={14} />
          Keep both
        </button>
        <button type="button" className="danger" onClick={onReplace}>
          <Trash2 size={14} />
          Replace old local files
        </button>
      </div>
      <p className="copy-conflict-note">
        Keep both preserves the listed files, but if there is only one active symlink for the item, the previous local file will become an orphan. Replace copies and verifies
        the new file first, repoints the symlink, then removes the listed old local files.
      </p>
    </div>
  );
}

export function ScanStatusDialog({
  prompt,
  onClose
}: {
  prompt: ScanStatusPrompt | null;
  onClose: () => void;
}) {
  const { timeFormat } = useUserPreferences();
  const jobId = prompt?.jobId ?? null;
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-status-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="scan-status-dialog-title">{prompt.title}</h2>
            <p>{`Job #${prompt.jobId} - ${prompt.description}`}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close scan status window" onClose={onClose} />
        </div>

        {jobQuery.error ? <p className="panel-message action-error">{jobQuery.error.message}</p> : null}

        <ScanProgressPanel job={currentJob} pendingJobId={jobId} />

        <div className="audit-dialog-events">
          <JobEventsHeader label="Scan events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading scan events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          <p className="panel-message">Closing this window leaves the scan running in the background.</p>
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

export function AuditStatusDialog({
  prompt,
  onClose
}: {
  prompt: AuditStatusPrompt | null;
  onClose: () => void;
}) {
  const { timeFormat } = useUserPreferences();
  const jobId = prompt?.jobId ?? null;
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const auditRunQuery = useQuery({
    queryKey: ["audit-run-by-job", jobId],
    queryFn: () => api.auditByJob(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: jobActive ? 500 : 2500
  });
  const auditRun = auditRunQuery.data ?? null;
  const auditRunId = prompt?.auditRunId ?? auditRun?.id ?? null;
  const auditResults = useQuery({
    queryKey: ["audit-results", auditRunId],
    queryFn: () => api.auditResults(auditRunId!),
    enabled: Boolean(prompt && auditRunId),
    refetchInterval: jobActive ? 1500 : false
  });
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-status-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="audit-status-dialog-title">{prompt.title}</h2>
            <p>{`Job #${prompt.jobId} - ${prompt.description}`}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close audit status window" onClose={onClose} />
        </div>

        {jobQuery.error ? <p className="panel-message action-error">{jobQuery.error.message}</p> : null}
        {auditRunQuery.error ? <p className="panel-message action-error">{auditRunQuery.error.message}</p> : null}
        {auditResults.error ? <p className="panel-message action-error">{auditResults.error.message}</p> : null}

        <AuditProgressPanel job={currentJob} pendingJobId={jobId} auditRun={auditRun} />

        {auditRunId && !auditResults.isLoading && !auditResults.error ? <AuditResultSummary results={auditResults.data ?? []} /> : null}

        <div className="audit-dialog-events">
          <JobEventsHeader label="Audit events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading audit events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          <p className="panel-message">Closing this window leaves the audit running in the background.</p>
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

export function AuditResultSummary({ results }: { results: AuditResultRecord[] }) {
  const attentionResults = results.filter((result) => result.status !== "pass");
  if (attentionResults.length === 0) return null;

  return (
    <section className="audit-result-summary" aria-label="Audit findings">
      <div className="audit-dialog-section-title">
        <TriangleAlert size={15} />
        <span>Audit findings</span>
      </div>
      <div className="audit-result-list">
        {attentionResults.map((result) => (
          <article className="audit-result-item" key={result.id}>
            <div>
              <strong>{basenameFromPath(result.targetPath)}</strong>
              <small>{result.message}</small>
            </div>
            <StatusPill value={result.status === "source_issue" ? "Source issue" : "Failed"} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function ScanScopeBlock({
  checked,
  children,
  detail,
  icon,
  title,
  onChange
}: {
  checked: boolean;
  children?: ReactNode;
  detail: string;
  icon: ReactNode;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <section className={checked ? "scan-scope-block selected" : "scan-scope-block"} aria-label={title}>
      <label className="scan-scope-control">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {icon}
        <span className="scan-scope-copy">
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
      </label>
      {checked && children ? <div className="scan-scope-content">{children}</div> : null}
    </section>
  );
}

export function FolderScopePicker({
  ariaLabel,
  emptyMessage,
  lastScannedBySection,
  sections,
  selectedSections,
  onToggle
}: {
  ariaLabel: string;
  emptyMessage: string;
  lastScannedBySection: Record<string, string | null>;
  sections: Array<{ section: string; title?: string | null }>;
  selectedSections: string[];
  onToggle: (section: string, checked: boolean) => void;
}) {
  if (sections.length === 0) return <p className="scan-scope-empty">{emptyMessage}</p>;

  return (
    <div className="folder-scope-grid" role="group" aria-label={ariaLabel}>
      {sections.map((section) => (
        <ScopeToggle
          key={section.section}
          checked={selectedSections.includes(section.section)}
          icon={<Folder size={15} />}
          label={sectionDisplayTitle(section)}
          detail={scanAgeLabel(lastScannedBySection[section.section] ?? null)}
          onChange={(checked) => onToggle(section.section, checked)}
        />
      ))}
    </div>
  );
}

function ScopeToggle({
  checked,
  detail,
  icon,
  label,
  onChange
}: {
  checked: boolean;
  detail?: string;
  icon: ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={checked ? "scope-toggle selected" : "scope-toggle"}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {icon}
      <span className="scope-toggle-copy">
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
    </label>
  );
}

export function CopyProgressPanel({
  job,
  pendingJobId,
  isStarting = false,
  compact = false,
  failedEvents,
  failedEventsLoading = false,
  failedEventsError
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  isStarting?: boolean;
  compact?: boolean;
  failedEvents?: JobEventRecord[];
  failedEventsLoading?: boolean;
  failedEventsError?: string | null;
}) {
  const progress = copyProgressFromJob(job);
  const completed = copyCompletedCount(progress);
  const symlinked = copySymlinkedCount(progress);
  const stagePercent = copyStagePercent(job, progress);
  const overallPercent = copyOverallProgressPercent(job, progress);
  const currentIndex = progress.current > 0 ? progress.current : completed;
  const currentItem = copyCurrentItem(progress, job);
  const statusLabel = isStarting ? "Starting" : copyStageLabel(progress.stage, progress.direction);
  const countLabel = progress.total > 0 ? `${formatNumber(Math.min(Math.max(currentIndex, completed), progress.total))} / ${formatNumber(progress.total)}` : "No matching files";
  const transferSpeedSecondary = copyTransferSpeedSecondaryLabel(progress);
  const throughputLabel = copyThroughputLabel(progress);
  return (
    <div className={`audit-progress-panel copy-progress-panel${compact ? " compact" : ""}`}>
      <div className="audit-progress-header copy-progress-header">
        <span>
          <strong>{statusLabel}</strong>
          {job ? <StatusPill value={job.status} /> : null}
          {!job && pendingJobId ? <span className="copy-progress-job-id">Job #{pendingJobId}</span> : null}
        </span>
        <small>{countLabel}</small>
      </div>
      <div className="copy-progress-bars">
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>{statusLabel}</span>
            <strong>{stagePercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track copy-step-track" aria-label="Current copy step progress">
            <span style={{ width: `${stagePercent}%` }} />
          </div>
        </div>
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>Overall job</span>
            <strong>{overallPercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track copy-overall-track" aria-label="Overall copy job progress">
            <span style={{ width: `${overallPercent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file">
        <File size={15} />
        <span>
          <strong>{currentItem.title}</strong>
          {currentItem.fileName ? <small className="copy-current-file-name">{currentItem.fileName}</small> : null}
          <small>{currentItem.detail}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats">
        <span>
          <strong>{formatNumber(progress.copied)}</strong>
          Copied
        </span>
        <span>
          <strong>{formatNumber(symlinked)}</strong>
          Symlinked
        </span>
        <span>
          <strong>{formatNumber(progress.repointed)}</strong>
          Matched existing
        </span>
        <span>
          <strong>{formatNumber(progress.conflicts)}</strong>
          Conflicts
        </span>
        <div className={progress.failed > 0 ? "copy-progress-stat-bad" : undefined}>
          {progress.failed > 1 && failedEvents ? (
            <CopyFailedItemsTooltip count={progress.failed} events={failedEvents} loading={failedEventsLoading} error={failedEventsError} />
          ) : (
            <>
              <strong>{formatNumber(progress.failed)}</strong>
              Failed
            </>
          )}
        </div>
        <span>
          <strong>{copyTransferSpeedLabel(progress)}</strong>
          {transferSpeedSecondary ? <small>{transferSpeedSecondary}</small> : null}
          {throughputLabel}
        </span>
        <span>
          <strong>{copyElapsedLabel(job)}</strong>
          Running
        </span>
        <span>
          <strong>{copyRemainingLabel(job, progress, overallPercent)}</strong>
          Remaining
        </span>
        <span>
          <strong>{progress.sizeBytes == null ? "-" : formatBytes(progress.sizeBytes)}</strong>
          Current size
        </span>
      </div>
    </div>
  );
}

function CopyFailedItemsTooltip({ count, events, loading, error }: { count: number; events: JobEventRecord[]; loading: boolean; error?: string | null }) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const items = useMemo(() => copyFailedItemSummaries(events), [events]);
  const unidentified = Math.max(0, count - items.length);
  const open = hovered || pinned;

  useEffect(() => {
    if (!pinned) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setHovered(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pinned]);

  function close() {
    setPinned(false);
    setHovered(false);
  }

  function togglePinned() {
    if (pinned) {
      close();
    } else {
      setPinned(true);
    }
  }

  return (
    <div
      ref={rootRef}
      className={`copy-failed-items-tooltip${open ? " is-open" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => !pinned && setHovered(false)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && !pinned && setHovered(false)}
    >
      <button type="button" aria-label={`View ${formatNumber(count)} failed items`} aria-controls={tooltipId} aria-expanded={open} onClick={togglePinned} onFocus={() => setHovered(true)}>
        <strong>{formatNumber(count)}</strong>
        <span>Failed</span>
        <small>
          <ListChecks size={12} />
          View failed items
        </small>
      </button>
      <div id={tooltipId} className="copy-failed-items-tooltip-panel" role="region" aria-label="Failed item details" aria-hidden={!open}>
        <div className="copy-failed-items-tooltip-heading">
          <span>
            <TriangleAlert size={14} />
            <strong>Failed items</strong>
          </span>
          <button type="button" className="copy-failed-items-tooltip-close" aria-label="Close failed item details" onClick={close}>
            <X size={14} />
          </button>
        </div>
        {items.length > 0 ? (
          <ul className="copy-failed-items-tooltip-list">
            {items.map((item) => (
              <li key={item.key}>
                <strong>{item.title}</strong>
                {item.fileName ? <span>{item.fileName}</span> : null}
                <small>{item.reason}</small>
              </li>
            ))}
          </ul>
        ) : null}
        {loading ? <p>Loading failed item details...</p> : null}
        {error ? <p className="copy-failed-items-tooltip-error">Failed item details could not be loaded.</p> : null}
        {!loading && !error && unidentified > 0 ? <p>{formatNumber(unidentified)} failed item{unidentified === 1 ? " was" : "s were"} not identified by an item-level event.</p> : null}
      </div>
    </div>
  );
}

function CopyLogEventRow({ event, timeFormat }: { event: JobEventRecord; timeFormat: TimeFormatPreference }) {
  const record = recordFromUnknown(event.data);
  const fileName = basenameFromPath(typeof record?.currentFile === "string" ? record.currentFile : typeof record?.sourcePath === "string" ? record.sourcePath : null);
  const chips = copyEventChips(record);
  return (
    <article className={`event event-${event.level} copy-event`}>
      <div className="event-header">
        <span>{formatTime(event.timestamp, timeFormat)}</span>
        <StatusPill value={formatEventLevel(event.level)} />
      </div>
      <strong>{event.message}</strong>
      {fileName ? (
        <small className="copy-event-file">
          <File size={13} />
          <span>{fileName}</span>
        </small>
      ) : null}
      <LogChipList chips={chips} />
      {hasLogData(event.data) ? (
        <details className="event-details">
          <summary>Raw details</summary>
          <pre>{formatLogData(event.data)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function LogEventRow({ event, timeFormat, job }: { event: JobEventRecord; timeFormat: TimeFormatPreference; job?: JobRecord | null }) {
  const chips = eventDataChips(event.data, 7, job?.type === "scan" ? scanOptionsFromJob(job) : job?.type === "audit" ? auditOptionsFromJob(job) : null);
  return (
    <article className={`event event-${event.level}`}>
      <div className="event-header">
        <span>{formatTime(event.timestamp, timeFormat)}</span>
        <StatusPill value={formatEventLevel(event.level)} />
      </div>
      <strong>{event.message}</strong>
      <LogChipList chips={chips} />
      {hasLogData(event.data) ? (
        <details className="event-details">
          <summary>Raw details</summary>
          <pre>{formatLogData(event.data)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function AuditProgressPanel({
  job,
  pendingJobId,
  auditRun,
  compact = false
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  auditRun?: AuditRunRecord | null;
  compact?: boolean;
}) {
  const progress = auditProgressFromJob(job, auditRun);
  const statusLabel = auditStageLabel(progress.stage, job?.status);
  const progressPercent = auditProgressPercent(job, progress);
  const countLabel = progress.total > 0 ? `${formatNumber(progress.checked)} / ${formatNumber(progress.total)}` : pendingJobId ? "Waiting for audit progress" : "Not started";
  const currentFile = basenameFromPath(progress.currentFile);
  const detail = progress.currentTitle ?? currentFile ?? auditStatusDetail(job, progress);
  return (
    <div className={`audit-progress-panel copy-progress-panel${compact ? " compact" : ""}`}>
      <div className="audit-progress-header copy-progress-header">
        <span>
          <strong>{statusLabel}</strong>
          {job ? <StatusPill value={job.status} /> : null}
          {!job && pendingJobId ? <span className="copy-progress-job-id">Job #{pendingJobId}</span> : null}
        </span>
        <small>{countLabel}</small>
      </div>
      <div className="copy-progress-bars">
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>Audit progress</span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track" aria-label="Audit progress">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file scan-current-phase">
        <Activity size={15} />
        <span>
          <strong>{detail}</strong>
          <small>{progress.currentTitle && currentFile ? currentFile : auditStatusDetail(job, progress)}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats">
        <span>
          <strong>{formatNumber(progress.checked)}</strong>
          Checked
        </span>
        <span>
          <strong>{formatNumber(progress.passed)}</strong>
          Passed
        </span>
        <span>
          <strong>{formatNumber(progress.failed)}</strong>
          Failed
        </span>
        <span>
          <strong>{formatNumber(progress.sourceUnknown)}</strong>
          No recorded source
        </span>
        <span>
          <strong>{formatNumber(progress.sourceMissing)}</strong>
          Recorded source missing
        </span>
        <span>
          <strong>{formatNumber(progress.sourceCompareErrors)}</strong>
          Source compare errors
        </span>
        <span>
          <strong>{formatNumber(progress.byteMismatches)}</strong>
          Byte mismatches
        </span>
        <span>
          <strong>{job ? jobDurationLabel(job) : "-"}</strong>
          Duration
        </span>
      </div>
      {job ? <LogChipList chips={jobProgressChips(job, 8)} /> : null}
    </div>
  );
}

export function JobScope({
  job,
  sections,
  linkRowsById,
  linkRowsLoading,
  linkRowsError
}: {
  job: JobRecord;
  sections: Array<{ section: string; title?: string | null }>;
  linkRowsById?: Map<number, MediaLinkRow>;
  linkRowsLoading?: boolean;
  linkRowsError?: string | null;
}) {
  const storageLocations = useStorageLocations();
  if (job.type === "scan") {
    const options = scanOptionsFromJob(job);
    if (!options) return <span className="muted-cell">-</span>;
    if (options.titleScopes?.length) {
      const detail = formatTitleScanJobDetail(options.titleScopes, sections);
      return (
        <span className="job-scope-cell" title={detail}>
          <span>Title rescan</span>
          <small>{detail}</small>
        </span>
      );
    }
    const scopes = scanScopeLabels(options);
    const sectionText = formatScopedFolderParts(scanFolderScopeParts(options, sections));
    return (
      <span className="job-scope-cell" title={sectionText}>
        <span>{scopes.length > 0 ? scopes.join(", ") : "No scope"}</span>
        <small>{sectionText}</small>
      </span>
    );
  }

  if (job.type === "audit") {
    const options = auditOptionsFromJob(job);
    const sectionText = formatAuditScope(options, sections);
    const modeText = options.mode === "fast" ? "Fast audit" : options.mode === "deep" ? "Deep audit" : "Audit";
    const selectedLinkIds = options.linkIds ?? [];
    return (
      <span className="job-scope-cell" title={selectedLinkIds.length > 0 ? undefined : sectionText}>
        <span>{modeText}</span>
        <JobScopeDetail text={sectionText} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "copy") {
    const options = copyOptionsFromJob(job);
    const sectionText = formatCopyScope(options, sections);
    const directionText = `Copy to ${storageLocationName(storageLocations, options?.direction === "to_remote" ? "remote" : "local")}`;
    const selectedLinkIds = options?.linkIds ?? [];
    return (
      <span className="job-scope-cell" title={selectedLinkIds.length > 0 ? undefined : sectionText}>
        <span>{directionText}</span>
        <JobScopeDetail text={sectionText} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "path_migration") {
    const progress = recordFromUnknown(job.progress);
    const migrationId = finiteNumberFromUnknown(progress?.migrationId);
    return (
      <span className="job-scope-cell">
        <span>Managed paths</span>
        <small>{migrationId > 0 ? `Migration #${migrationId}` : "Path reconciliation"}</small>
      </span>
    );
  }

  return <span className="muted-cell">-</span>;
}

function JobScopeDetail({
  text,
  selectedLinkIds,
  linkRowsById,
  linkRowsLoading,
  linkRowsError
}: {
  text: string;
  selectedLinkIds: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  linkRowsLoading?: boolean;
  linkRowsError?: string | null;
}) {
  if (selectedLinkIds.length === 0) return <small>{text}</small>;
  const canShowTitleLookup = Boolean(linkRowsById || linkRowsLoading || linkRowsError);
  return (
    <small className="job-scope-detail-line">
      <span>{text}</span>
      {canShowTitleLookup ? <SelectedLinkTitlesTooltip linkIds={selectedLinkIds} linkRowsById={linkRowsById} isLoading={linkRowsLoading} error={linkRowsError} /> : null}
    </small>
  );
}

function SelectedLinkTitlesTooltip({
  linkIds,
  linkRowsById,
  isLoading,
  error
}: {
  linkIds: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  isLoading?: boolean;
  error?: string | null;
}) {
  const summaries = selectedLinkTitleSummaries(linkIds, linkRowsById);
  return (
    <span className="job-link-title-tooltip" tabIndex={0} aria-label="View selected titles">
      <Info size={12} />
      <span className="job-link-title-tooltip-panel" role="tooltip">
        <strong>Selected titles</strong>
        {isLoading ? <span>Loading titles...</span> : null}
        {!isLoading && error ? <span>{error}</span> : null}
        {!isLoading && !error && summaries.length === 0 ? <span>No matching titles found in the current inventory.</span> : null}
        {!isLoading && !error && summaries.length > 0 ? (
          <ul>
            {summaries.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        ) : null}
      </span>
    </span>
  );
}

export function JobsTable({
  jobs,
  sections,
  onScanJobSelect,
  onAuditJobSelect,
  onCopyJobSelect
}: {
  jobs: JobRecord[];
  sections: Array<{ section: string; title?: string | null }>;
  onScanJobSelect?: (job: JobRecord) => void;
  onAuditJobSelect?: (job: JobRecord) => void;
  onCopyJobSelect?: (job: JobRecord) => void;
}) {
  const preferences = useUserPreferences();
  const { timeFormat } = preferences;
  const queryClient = useQueryClient();
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const saveRecentJobsFilter = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (savedPreferences) => {
      queryClient.setQueryData(["user-preferences"], savedPreferences);
    }
  });
  const completedWindowMinutes = normalizeRecentJobsCompletedWindowMinutes(preferences.recentJobsCompletedWindowMinutes);
  const visibleJobs = visibleDashboardJobs(jobs, completedWindowMinutes);
  const selectedJobLinkIds = useMemo(() => selectedLinkIdsFromJobs(visibleJobs), [visibleJobs]);
  const selectedJobLinkRows = useQuery({
    queryKey: ["media-links-by-ids", selectedJobLinkIds],
    queryFn: () => api.mediaLinksByIds(selectedJobLinkIds),
    enabled: selectedJobLinkIds.length > 0,
    staleTime: 5000
  });
  const selectedJobLinkRowsById = useMemo(() => new Map((selectedJobLinkRows.data ?? []).map((link) => [link.id, link])), [selectedJobLinkRows.data]);
  return (
    <Panel
      title="Recent Jobs"
      icon={<Activity size={18} />}
      actions={
        <label className="recent-jobs-filter">
          <span>Finished within</span>
          <select
            value={completedWindowMinutes}
            disabled={saveRecentJobsFilter.isPending}
            onChange={(event) => {
              saveRecentJobsFilter.mutate({
                ...preferences,
                recentJobsCompletedWindowMinutes: normalizeRecentJobsCompletedWindowMinutes(Number(event.currentTarget.value))
              });
            }}
          >
            {recentJobsCompletedWindowOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {visibleJobs.length === 0 ? <p className="panel-message">No active jobs or finished jobs in the selected window.</p> : null}
      {saveRecentJobsFilter.error ? <p className="panel-message action-error">{saveRecentJobsFilter.error.message}</p> : null}
      {visibleJobs.length > 0 ? (
        <table className="responsive-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Scope</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th className="actions-cell">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleJobs.map((job) => {
              const canViewScanJob = job.type === "scan" && Boolean(onScanJobSelect);
              const canViewAuditJob = job.type === "audit" && Boolean(onAuditJobSelect);
              const canViewCopyJob = job.type === "copy" && Boolean(onCopyJobSelect);
              const canTerminate = canTerminateJob(job);
              const hasActions = canViewScanJob || canViewAuditJob || canViewCopyJob || canTerminate;
              return (
                <tr key={job.id}>
                  <td>#{job.id}</td>
                  <td>{formatJobType(job.type)}</td>
	                  <td>
	                    <JobScope
	                      job={job}
	                      sections={sections}
	                      linkRowsById={selectedJobLinkRowsById}
	                      linkRowsLoading={selectedJobLinkRows.isLoading || selectedJobLinkRows.isFetching}
	                      linkRowsError={selectedJobLinkRows.error?.message ?? null}
	                    />
	                  </td>
                  <td>
                    <StatusPill value={job.status} />
                  </td>
                  <td>{formatDate(job.startedAt, timeFormat)}</td>
                  <td>{formatDate(job.finishedAt, timeFormat)}</td>
                  <td className="actions-cell">
                    <span className="table-action-buttons">
                      {canViewScanJob && onScanJobSelect ? (
                        <button type="button" className="icon-button" title={`View scan status for job #${job.id}`} aria-label={`View scan status for job #${job.id}`} onClick={() => onScanJobSelect(job)}>
                          <Search size={15} />
                        </button>
                      ) : null}
                      {canViewAuditJob && onAuditJobSelect ? (
                        <button type="button" className="icon-button" title={`View audit status for job #${job.id}`} aria-label={`View audit status for job #${job.id}`} onClick={() => onAuditJobSelect(job)}>
                          <ListChecks size={15} />
                        </button>
                      ) : null}
                      {canViewCopyJob && onCopyJobSelect ? (
                        <button type="button" className="icon-button" title={`View copy progress for job #${job.id}`} aria-label={`View copy progress for job #${job.id}`} onClick={() => onCopyJobSelect(job)}>
                          <Activity size={15} />
                        </button>
                      ) : null}
                      {canTerminate ? (
                        <button
                          type="button"
                          className="table-action-button danger terminate"
                          title={`Terminate job #${job.id}`}
                          aria-label={`Terminate job #${job.id}`}
                          disabled={terminateJob.isPending}
                          onClick={() => setTerminatePrompt(job)}
                        >
                          <OctagonX size={15} />
                          <span>Terminate</span>
                        </button>
                      ) : null}
                      {!hasActions ? (
                        <span className="muted-cell">-</span>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <TerminateJobDialog
        job={terminatePrompt}
        error={terminateJob.error?.message}
        isPending={terminateJob.isPending}
        onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
        onConfirm={(jobId) => terminateJob.mutate(jobId)}
      />
    </Panel>
  );
}

function JobStatusHeaderActions({
  closeLabel,
  onClose
}: {
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="audit-dialog-header-actions">
      <button type="button" className="icon-only secondary" aria-label={closeLabel} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
