import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Archive, CheckCircle2, ChevronDown, ChevronRight, Copy, File, FileText, Folder, Info, ListChecks, OctagonX, Play, RotateCcw, Search, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "./api";
import { defaultAdvancedSettings, normalizeAdvancedSettings } from "../shared/advancedSettings";
import { eventDataChips, formatEventLevel, formatJobType, formatLogData, hasLogData, jobProgressChips } from "./logDisplay";
import { auditOptionsFromJob, copyOptionsFromJob, scanOptionsFromJob } from "./jobScopeLocks";
import { jobEventCountLabel } from "./jobEvents";
import { groupAdjacentJobs } from "./jobGrouping";
import { normalizeRecentJobsCompletedWindowMinutes, recentJobsCompletedWindowOptions, visibleDashboardJobs } from "./recentJobs";
import { roughDuration } from "../shared/auditEstimate";
import { type AuditEstimate, type AuditMode, type AuditResultRecord, type AuditRunRecord, type CopyConflictPreview, type CopyFailureItem, type CopyRetryPlan, type CopyRetryStarted, type JobEventRecord, type JobRecord, type JobSelectionSummary, type CopyLocalConflictStrategy, type MediaLinkRow, type OrphanPurgeItem, type OrphanPurgeItemOutcome, type TimeFormatPreference } from "../shared/types";
import { JobStatusTerminateAction, LogChipList, Panel, ScanProgressPanel, StatusPill, TerminateJobDialog } from "./App";
import { useAccess } from "./access";
import { AuditPrompt, AuditStatusPrompt, canTerminateJob, copyElapsedLabel, CopyPrompt, finiteNumberFromUnknown, formatBytes, formatDate, formatNumber, formatTime, invalidateCopyJobData, recordFromUnknown, scanAgeLabel, ScanBatchStatusPrompt, ScanStatusPrompt, sectionDisplayTitle, storageLocationName, useJobEventTimeline, useModalLifecycle, useStartCopyJob, useStorageLocations, useTerminateJobMutation, useUserPreferences } from "./appShared";
import { auditProgressFromJob, auditProgressPercent, auditStageLabel, auditStatusDetail, basenameFromPath, copyCompletedCount, copyCompletedItemSummaries, copyCurrentItem, copyEventChips, copyFailedItemSummaries, copyOverallProgressPercent, copyProgressFromJob, copyRemainingLabel, copyRetryStartedMessage, copyStageLabel, copyStagePercent, copySymlinkedCount, copyThroughputLabel, copyTransferSpeedLabel, copyTransferSpeedSecondaryLabel, copyWorkTotalFromJob, formatAuditScope, formatCopyScope, formatScanScope, formatScopedFolderParts, formatTitleScanJobDetail, jobDurationLabel, scanFolderScopeParts, scanScopeLabels, orphanPurgeCurrentFile, orphanPurgeHoldingAreaView, orphanPurgeProgressFromJob, orphanPurgeProgressPercent, orphanPurgeRateLabel, orphanPurgeRemainingLabel, orphanPurgeScopeText, orphanPurgeStageLabel, selectedLinkIdsFromJobs, selectedLinkTitleSummaries, singleSelectedLinkTitle, type OrphanPurgeStatusPrompt } from "./jobPresentationUtils";
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
  // Byte compare is a per-run choice; the setting only picks where the checkbox starts.
  const [byteCompareChoice, setByteCompareChoice] = useState<boolean | null>(null);
  const byteCompare = byteCompareChoice ?? advanced.audit.byteCompareWhenSourceKnown;
  const estimates = useQueries({
    queries: (["fast", "deep"] as const).map((mode) => ({
      queryKey: ["audit-estimate", mode, byteCompare, prompt?.options ?? null],
      queryFn: () => api.estimateAudit({ ...(prompt?.options ?? {}), mode, byteCompare }),
      enabled: Boolean(prompt && !jobId && advancedSettings.data),
      staleTime: 30_000
    }))
  });
  const [fastEstimate, deepEstimate] = estimates.map((query) => query.data ?? null);
  const estimateError = estimates.find((query) => query.error)?.error ?? null;
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
        ...auditPrompt.options,
        mode,
        byteCompare
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
    setByteCompareChoice(null);
  }, [prompt]);

  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const canStart = !jobId && !startAudit.isPending;
  const highlightedMode = selectedMode ?? (!jobId ? defaultAuditMode : null);
  const refusalFor = (mode: AuditMode) => (mode === "fast" ? fastEstimate : deepEstimate)?.refusal ?? null;

  function queueAudit(mode: AuditMode) {
    if (!canStart || !prompt || refusalFor(mode)) return;
    startAudit.mutate({ auditPrompt: prompt, mode });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Audit</span>
            <h2 id="audit-dialog-title">{prompt.title}</h2>
            <p>{prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close audit window" onClose={onClose} />
        </div>

        {!jobId ? (
          <AuditEstimatePanel
            fast={fastEstimate}
            deep={deepEstimate}
            loading={estimates.some((query) => query.isLoading)}
            error={estimateError?.message ?? null}
            byteCompare={byteCompare}
            onByteCompareChange={setByteCompareChoice}
          />
        ) : null}

        <div className="audit-mode-grid" role="group" aria-label="Audit mode">
          <button type="button" className={`audit-mode-card${highlightedMode === "fast" ? " selected" : ""}`} onClick={() => queueAudit("fast")} disabled={!canStart || Boolean(refusalFor("fast"))}>
            <Play size={17} />
            <span>
              <strong>Fast Audit</strong>
              <small>Read every byte of the file without a full decode.{fastEstimate && !fastEstimate.refusal ? ` ${capitalize(roughDuration(fastEstimate.estimatedSeconds))}.` : ""}</small>
              {!jobId && defaultAuditMode === "fast" ? <em>Default</em> : null}
            </span>
          </button>
          <button type="button" className={`audit-mode-card${highlightedMode === "deep" ? " selected" : ""}`} onClick={() => queueAudit("deep")} disabled={!canStart || Boolean(refusalFor("deep"))}>
            <Activity size={17} />
            <span>
              <strong>Deep Audit</strong>
              <small>Decode media fully for stricter validation.{deepEstimate && !deepEstimate.refusal ? ` ${capitalize(roughDuration(deepEstimate.estimatedSeconds))}.` : ""}</small>
              {!jobId && defaultAuditMode === "deep" ? <em>Default</em> : null}
            </span>
          </button>
        </div>
        {!jobId && (refusalFor("fast") || refusalFor("deep")) ? (
          <div className="panel-message audit-refusal" role="note">
            {[...new Set([refusalFor("fast"), refusalFor("deep")].filter((text): text is string => Boolean(text)))].map((text) => (
              <p key={text}>{text}</p>
            ))}
          </div>
        ) : null}

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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function AuditEstimatePanel({
  fast,
  deep,
  loading,
  error,
  byteCompare,
  onByteCompareChange
}: {
  fast: AuditEstimate | null;
  deep: AuditEstimate | null;
  loading: boolean;
  error: string | null;
  byteCompare: boolean;
  onByteCompareChange: (value: boolean) => void;
}) {
  const estimate = fast ?? deep;
  const totalFiles = estimate ? estimate.local.files + estimate.remote.files : 0;
  const totalBytes = estimate ? estimate.local.bytes + estimate.remote.bytes : 0;
  return (
    <div className="audit-estimate" aria-live="polite">
      {error ? <p className="panel-message action-error">{error}</p> : null}
      {loading && !estimate ? <p className="panel-message">Estimating size and time...</p> : null}
      {estimate ? (
        <>
          <p className="audit-estimate-summary">
            <strong>{formatNumber(totalFiles)} {totalFiles === 1 ? "file" : "files"}</strong>, {formatBytes(totalBytes)}
            {estimate.local.files > 0 && estimate.remote.files > 0 ? ` (${formatNumber(estimate.local.files)} local, ${formatNumber(estimate.remote.files)} remote)` : ""}
            {fast && !fast.refusal ? ` · fast ${roughDuration(fast.estimatedSeconds)}` : ""}
            {deep && !deep.refusal ? ` · deep ${roughDuration(deep.estimatedSeconds)}` : ""}
          </p>
          {estimate.remote.files > 0 ? (
            <p className="audit-estimate-warning">
              <TriangleAlert size={14} /> A remote audit reads every remote byte through the remote mount: this one downloads {formatBytes(estimate.remote.bytes)}.
            </p>
          ) : null}
          <label className="audit-estimate-option">
            <input type="checkbox" checked={byteCompare} onChange={(event) => onByteCompareChange(event.target.checked)} />
            <span>
              Byte compare against the recorded copy source
              <small>
                {estimate.withKnownSource.files > 0
                  ? `Also reads the source of ${formatNumber(estimate.withKnownSource.files)} copied ${estimate.withKnownSource.files === 1 ? "file" : "files"} (${formatBytes(estimate.withKnownSource.bytes)}), usually through the remote mount. Copies already byte-compare every file.`
                  : "No file in this audit has a recorded copy source."}
              </small>
            </span>
          </label>
          <p className="audit-estimate-note">Times are rough: a fast audit runs at disk or download speed, a deep audit decodes every frame in software.</p>
        </>
      ) : null}
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
  const canDelete = useAccess().can("library.delete");
  const queryClient = useQueryClient();
  const { timeFormat } = useUserPreferences();
  const [jobId, setJobId] = useState<number | null>(prompt?.jobId ?? null);
  const [startedPromptKey, setStartedPromptKey] = useState<string | null>(null);
  const [localConflictStrategy, setLocalConflictStrategy] = useState<CopyLocalConflictStrategy | null>(null);
  const [allowSourceTitleMismatch, setAllowSourceTitleMismatch] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
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
  const resetStartCopy = startCopy.reset;

  useEffect(() => {
    resetStartCopy();
    setJobId(prompt?.jobId ?? null);
    setStartedPromptKey(null);
    setLocalConflictStrategy(null);
    setAllowSourceTitleMismatch(false);
    setRetryNotice(null);
  }, [prompt?.key, prompt?.jobId, resetStartCopy]);

  useEffect(() => {
    if (!prompt?.autoStart || !prompt.options || jobId || startedPromptKey === prompt.key || startCopy.isPending) return;
    const requiresLocalResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options.localConflictStrategy && !localConflictStrategy);
    const requiresSourceResolution = Boolean((prompt.conflicts?.totalSourceTitleBlocks ?? 0) > 0 && !prompt.options.allowSourceTitleMismatch && !allowSourceTitleMismatch);
    if (requiresLocalResolution || requiresSourceResolution) return;
    const options = {
      ...prompt.options,
      ...(localConflictStrategy ? { localConflictStrategy } : {}),
      ...(allowSourceTitleMismatch ? { allowSourceTitleMismatch: true } : {})
    };
    const resolvedPromptKey = [prompt.key, localConflictStrategy, allowSourceTitleMismatch ? "source-title-override" : null].filter(Boolean).join(":");
    if (startedPromptKey === resolvedPromptKey) return;
    setStartedPromptKey(resolvedPromptKey);
    startCopy.mutate({ ...prompt, key: resolvedPromptKey, options });
  }, [allowSourceTitleMismatch, jobId, localConflictStrategy, prompt, startCopy, startedPromptKey]);

  useEffect(() => {
    if (!currentJobId || currentJobStatus === "queued" || currentJobStatus === "running") return;
    invalidateCopyJobData(queryClient);
  }, [currentJobId, currentJobStatus, queryClient]);

  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const needsLocalConflictResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options?.localConflictStrategy && !localConflictStrategy && !jobId);
  const needsSourceTitleResolution = Boolean((prompt.conflicts?.totalSourceTitleBlocks ?? 0) > 0 && !prompt.options?.allowSourceTitleMismatch && !allowSourceTitleMismatch && !jobId);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-dialog-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="copy-dialog-title">{prompt.title}</h2>
            <p>{jobId ? `Job #${jobId} - ${prompt.description}` : prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
            <CopyRetryAction
              key={currentJobId}
              job={currentJob}
              onStarted={(started) => {
                setRetryNotice(copyRetryStartedMessage(started));
                setJobId(started.jobId);
              }}
            />
          </div>
          <JobStatusHeaderActions closeLabel="Close copy window" onClose={onClose} />
        </div>

        {retryNotice ? <p className="panel-message" role="status">{retryNotice}</p> : null}
        {startCopy.error ? <p className="panel-message action-error">{startCopy.error.message}</p> : null}

        {startCopy.error && !jobId ? (
          <p className="panel-message">The copy job was not queued. No files were changed.</p>
        ) : needsSourceTitleResolution && prompt.conflicts ? (
          <CopySourceTitleResolution conflicts={prompt.conflicts} onContinue={() => setAllowSourceTitleMismatch(true)} />
        ) : needsLocalConflictResolution && prompt.conflicts ? (
          <CopyConflictResolution conflicts={prompt.conflicts} onKeepBoth={() => setLocalConflictStrategy("keep_both")} onReplace={!canDelete ? undefined : () => setLocalConflictStrategy("replace")} />
        ) : (
          <CopyProgressPanel
            job={currentJob}
            pendingJobId={jobId}
            isStarting={startCopy.isPending}
            copyEvents={events.events}
            copyEventsLoading={events.isLoading || events.isFetchingNextPage}
            copyEventsError={events.error?.message}
          />
        )}

        {startCopy.error && !jobId ? null : <div className="audit-dialog-events">
          <JobEventsHeader label="Copy events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading copy events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {!jobId && !startCopy.error && !needsLocalConflictResolution && !needsSourceTitleResolution ? <p className="panel-message">Starting the copy job. Closing this window after start leaves the job running in the background.</p> : null}
          {needsSourceTitleResolution ? <p className="panel-message">Review and explicitly accept the source-title mismatch before starting this copy.</p> : null}
          {needsLocalConflictResolution ? <p className="panel-message">Choose how to handle the existing local file before starting this copy.</p> : null}
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <CopyLogEventRow key={event.id} event={event} timeFormat={timeFormat} />
              ))}
            </div>
          ) : null}
        </div>}
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

function CopySourceTitleResolution({ conflicts, onContinue }: { conflicts: CopyConflictPreview; onContinue: () => void }) {
  const risks = conflicts.sourceTitleRisks ?? [];
  return (
    <div className="copy-conflict-panel">
      <div className="copy-conflict-header">
        <TriangleAlert size={18} />
        <span>
          <strong>Source title mismatch</strong>
          <small>{formatNumber(risks.length)} source file{risks.length === 1 ? " does" : "s do"} not look like the selected library title.</small>
        </span>
      </div>
      <div className="copy-conflict-list">
        {risks.map((risk) => (
          <div key={`${risk.linkId}:${risk.sourcePath}`} className="copy-conflict-item">
            <strong>{risk.itemName}</strong>
            <small>{risk.relativePath}</small>
            <small>{risk.reason}: {risk.sourcePath}</small>
          </div>
        ))}
      </div>
      <div className="copy-conflict-actions">
        <button type="button" className="danger" onClick={onContinue}>
          <TriangleAlert size={14} />
          Copy these sources anyway
        </button>
      </div>
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
  /** Absent for someone who may not delete files. */
  onReplace?: () => void;
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
        {onReplace ? (
          <button type="button" className="danger" onClick={onReplace}>
            <Trash2 size={14} />
            Replace old local files
          </button>
        ) : null}
      </div>
      <p className="copy-conflict-note">
        Keep both preserves the listed files, but if there is only one active symlink for the item, the previous local file will become an orphan. {onReplace ? null : "Replacing them needs an admin. "}Replace copies and verifies
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
  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-status-dialog-title" tabIndex={-1}>
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

export function ScanBatchStatusDialog({
  prompt,
  sections,
  onClose,
  onJobSelect
}: {
  prompt: ScanBatchStatusPrompt | null;
  sections: Array<{ section: string; title?: string | null }>;
  onClose: () => void;
  onJobSelect: (job: JobRecord) => void;
}) {
  const jobIds = prompt?.jobIds ?? [];
  const jobQueries = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: ["job", jobId],
      queryFn: () => api.job(jobId),
      enabled: Boolean(prompt),
      refetchInterval: (query: { state: { data?: JobRecord } }) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" || !status ? 500 : false;
      }
    }))
  });
  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const jobs = jobQueries.map((query) => query.data).filter((job): job is JobRecord => Boolean(job));
  const finishedCount = jobs.filter((job) => job.status !== "queued" && job.status !== "running").length;
  const error = jobQueries.find((query) => query.error)?.error;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog scan-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-batch-dialog-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="scan-batch-dialog-title">{prompt.title}</h2>
            <p>{prompt.description}</p>
          </div>
          <JobStatusHeaderActions closeLabel="Close folder scan status window" onClose={onClose} />
        </div>
        <div className="scan-batch-summary">
          <strong>{finishedCount} of {jobIds.length} folder jobs finished</strong>
          <span>Each folder runs independently up to the configured scan capacity.</span>
        </div>
        {error ? <p className="panel-message action-error">{error.message}</p> : null}
        <div className="scan-batch-list" aria-label="Folder scan jobs">
          {jobIds.map((jobId, index) => {
            const job = jobQueries[index]?.data;
            const options = job ? scanOptionsFromJob(job) : null;
            return (
              <div className="scan-batch-row" key={jobId}>
                <div>
                  <strong>{options ? formatScanScope(options, sections) : `Job #${jobId}`}</strong>
                  <span>Job #{jobId}</span>
                </div>
                {job ? <StatusPill value={job.status} /> : <span className="pill pill-info">Loading</span>}
                <button type="button" className="secondary" disabled={!job} onClick={() => job && onJobSelect(job)}>
                  <Search size={15} />
                  View status
                </button>
              </div>
            );
          })}
        </div>
        <p className="panel-message">Closing this window leaves all folder scans running in the background.</p>
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
  const auditResults = useInfiniteQuery({
    queryKey: ["audit-results", auditRunId],
    queryFn: ({ pageParam }) => api.auditResultPage(auditRunId!, { offset: pageParam, limit: 100, attentionOnly: true }),
    initialPageParam: 0,
    getNextPageParam: (page) => (page.hasMore ? page.offset + page.results.length : undefined),
    enabled: Boolean(prompt && auditRunId),
    refetchInterval: jobActive ? 1500 : false
  });
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });
  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const auditResultRecords = auditResults.data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-status-dialog-title" tabIndex={-1}>
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

        {auditRunId && !auditResults.isLoading && !auditResults.error ? <AuditResultSummary results={auditResultRecords} /> : null}
        {auditResults.hasNextPage && jobActive ? <p className="panel-message">Additional findings can be loaded after the audit finishes so newly inserted rows cannot shift the current page.</p> : null}
        {auditResults.hasNextPage && !jobActive ? (
          <button className="secondary" type="button" disabled={auditResults.isFetchingNextPage} onClick={() => auditResults.fetchNextPage()}>
            {auditResults.isFetchingNextPage ? "Loading more findings..." : "Load more audit findings"}
          </button>
        ) : null}

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
      {attentionResults.some((result) => result.status === "fail") ? (
        <p className="panel-message">
          Failed local files are listed on <Link to="/library" search={{ view: "damaged" }}>Damaged files</Link>, where a deep audit of just those files can be started.
        </p>
      ) : null}
      <div className="audit-result-list">
        {attentionResults.map((result) => (
          <article className="audit-result-item" key={result.id}>
            <div>
              <strong>{basenameFromPath(result.targetPath)}</strong>
              <small>{result.message}</small>
            </div>
            {result.status === "warning" ? <span className="pill pill-warning">Warning</span> : <StatusPill value={result.status === "source_issue" ? "Source issue" : "Failed"} />}
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
  activeSections,
  ariaLabel,
  emptyMessage,
  lastScannedBySection,
  sections,
  selectedSections,
  onToggle
}: {
  activeSections?: ReadonlySet<string>;
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
          busy={activeSections?.has(section.section)}
          icon={<Folder size={15} />}
          label={sectionDisplayTitle(section)}
          detail={activeSections?.has(section.section) ? "Scan active" : scanAgeLabel(lastScannedBySection[section.section] ?? null)}
          onChange={(checked) => onToggle(section.section, checked)}
        />
      ))}
    </div>
  );
}

function ScopeToggle({
  busy = false,
  checked,
  detail,
  icon,
  label,
  onChange
}: {
  busy?: boolean;
  checked: boolean;
  detail?: string;
  icon: ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`scope-toggle${checked ? " selected" : ""}${busy ? " busy" : ""}`}>
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
  copyEvents,
  copyEventsLoading = false,
  copyEventsError
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  isStarting?: boolean;
  compact?: boolean;
  copyEvents?: JobEventRecord[];
  copyEventsLoading?: boolean;
  copyEventsError?: string | null;
}) {
  const progress = copyProgressFromJob(job);
  const completed = copyCompletedCount(progress);
  const symlinked = copySymlinkedCount(progress);
  const stagePercent = copyStagePercent(job, progress);
  const overallPercent = copyOverallProgressPercent(job, progress);
  const currentIndex = progress.current > 0 ? progress.current : completed;
  const workTotal = job ? copyWorkTotalFromJob(job, progress.total) : progress.total;
  const currentItem = copyCurrentItem(progress, job);
  const statusLabel = isStarting ? "Starting" : copyStageLabel(progress.stage, progress.direction);
  const countLabel = workTotal > 0 ? `${formatNumber(Math.min(Math.max(currentIndex, completed), workTotal))} / ${formatNumber(workTotal)}` : "No matching files";
  const transferSpeedSecondary = copyTransferSpeedSecondaryLabel(progress);
  const throughputLabel = copyThroughputLabel(progress);
  return (
    <div className={`audit-progress-panel copy-progress-panel mobile-progress-panel${compact ? " compact" : ""}`} role="group" aria-label="Copy progress">
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
      <div className="audit-progress-stats copy-progress-stats mobile-progress-stats">
        <span>
          <strong>{formatNumber(progress.copied)}</strong>
          Copied
        </span>
        <div className={symlinked > 0 ? "copy-progress-stat-good" : undefined}>
          {symlinked > 0 && copyEvents ? (
            <CopyCompletedItemsTooltip count={symlinked} events={copyEvents} loading={copyEventsLoading} error={copyEventsError} />
          ) : (
            <>
              <strong>{formatNumber(symlinked)}</strong>
              Symlinked
            </>
          )}
        </div>
        <span>
          <strong>{formatNumber(progress.repointed)}</strong>
          Matched existing
        </span>
        <span>
          <strong>{formatNumber(progress.conflicts)}</strong>
          Conflicts
        </span>
        <div className={progress.failed > 0 ? "copy-progress-stat-bad" : undefined}>
          {progress.failed > 0 && copyEvents ? (
            <CopyFailedItemsTooltip
              jobId={job?.id ?? null}
              reviewReady={Boolean(job && job.status !== "queued" && job.status !== "running")}
              count={progress.failed}
              events={copyEvents}
              loading={copyEventsLoading}
              error={copyEventsError}
            />
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

type CopyItemDetail = {
  key: string;
  title: string;
  fileName: string | null;
  detail: string;
  statusDetail?: string;
  mediaLinkId?: number | null;
  removable?: boolean;
};

function CopyCompletedItemsTooltip({ count, events, loading, error }: { count: number; events: JobEventRecord[]; loading: boolean; error?: string | null }) {
  const items = useMemo(
    () => copyCompletedItemSummaries(events).map((item) => ({ ...item, detail: item.outcome, statusDetail: item.warning })),
    [events]
  );
  return <CopyItemDetailsTooltip count={count} kind="completed" items={items} loading={loading} error={error} />;
}

function CopyFailedItemsTooltip({
  jobId,
  reviewReady,
  count,
  events,
  loading,
  error
}: {
  jobId: number | null;
  reviewReady: boolean;
  count: number;
  events: JobEventRecord[];
  loading: boolean;
  error?: string | null;
}) {
  const canDelete = useAccess().can("library.delete");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [cleanupSelection, setCleanupSelection] = useState<number[] | null>(null);
  const failures = useQuery({
    queryKey: ["copy-failures", jobId],
    queryFn: () => api.copyFailures(jobId!),
    enabled: Boolean(jobId) && reviewReady,
    staleTime: 2_000
  });
  const fallbackItems = useMemo(
    () => copyFailedItemSummaries(events).map((item) => ({ ...item, detail: item.reason })),
    [events]
  );
  const items = failures.data
    ? failures.data.items.map((item) => ({
        key: item.key,
        title: item.itemName,
        fileName: item.fileName,
        detail: item.reason,
        statusDetail: item.symlinkStatusDetail,
        mediaLinkId: item.mediaLinkId,
        removable: item.symlinkStatus === "eligible" && item.mediaLinkId != null
      }))
    : fallbackItems;
  const eligibleIds = useMemo(
    () => failures.data?.items.flatMap((item) => (item.symlinkStatus === "eligible" && item.mediaLinkId ? [item.mediaLinkId] : [])) ?? [],
    [failures.data]
  );
  const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selectedIds.has(id));

  useEffect(() => {
    const eligible = new Set(eligibleIds);
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => eligible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [eligibleIds]);

  function toggleSelected(mediaLinkId: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(mediaLinkId)) next.delete(mediaLinkId);
      else next.add(mediaLinkId);
      return next;
    });
  }

  function reviewSelection(mediaLinkIds: number[]) {
    if (mediaLinkIds.length > 0) setCleanupSelection(mediaLinkIds);
  }

  return (
    <>
      <CopyItemDetailsTooltip
        count={count}
        kind="failed"
        items={items}
        loading={loading || (reviewReady && failures.isLoading)}
        error={error ?? failures.error?.message}
        toolbar={
          canDelete && jobId && failures.data && eligibleIds.length > 0 ? (
            <div className="failed-symlink-inline-toolbar">
              <strong>{formatNumber(selectedIds.size)} selected</strong>
              <button type="button" onClick={() => setSelectedIds(allSelected ? new Set() : new Set(eligibleIds))}>
                {allSelected ? "Clear" : "Select all"}
              </button>
              <button
                type="button"
                className="danger-button"
                aria-label={`Remove ${formatNumber(selectedIds.size)} selected symlink${selectedIds.size === 1 ? "" : "s"}`}
                onClick={() => reviewSelection([...selectedIds])}
                disabled={selectedIds.size === 0}
              >
                <Trash2 size={14} />
                Remove selected
              </button>
            </div>
          ) : null
        }
        itemControls={
          canDelete && failures.data
            ? (item) => {
                const removable = Boolean(item.removable && item.mediaLinkId);
                const itemLabel = item.fileName ? `${item.title}, ${item.fileName}` : item.title;
                return (
                  <div className="copy-item-details-item-actions">
                    <label className="copy-item-details-select-control" title={removable ? `Select symlink for ${itemLabel}` : item.statusDetail}>
                      <input
                        type="checkbox"
                        aria-label={`Select symlink for ${itemLabel}`}
                        checked={removable && selectedIds.has(item.mediaLinkId!)}
                        disabled={!removable}
                        onChange={() => removable && toggleSelected(item.mediaLinkId!)}
                      />
                    </label>
                    <button
                      type="button"
                      className="copy-item-details-remove-button"
                      aria-label={`Remove symlink for ${itemLabel}`}
                      title={removable ? `Review removal of symlink for ${itemLabel}` : item.statusDetail}
                      disabled={!removable}
                      onClick={() => removable && reviewSelection([item.mediaLinkId!])}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              }
            : undefined
        }
      />
      {cleanupSelection && jobId && failures.data
        ? createPortal(
            <FailedSymlinkCleanupDialog
              sourceJobId={jobId}
              failures={failures.data.items}
              initialSelectedIds={cleanupSelection}
              onClose={() => setCleanupSelection(null)}
            />,
            document.body
          )
        : null}
    </>
  );
}

function failedSymlinkStatusLabel(item: CopyFailureItem): string {
  if (item.symlinkStatus === "eligible") return "Ready to remove";
  if (item.symlinkStatus === "already_missing") return "Already missing";
  if (item.symlinkStatus === "superseded") return "Later copy succeeded";
  if (item.symlinkStatus === "reconciliation_required") return "Reconciliation required";
  if (item.symlinkStatus === "unavailable") return "Cannot verify mount";
  if (item.symlinkStatus === "changed") return "Symlink changed";
  return "Not safely identifiable";
}

function FailedSymlinkCleanupDialog({
  sourceJobId,
  failures,
  initialSelectedIds,
  onClose
}: {
  sourceJobId: number;
  failures: CopyFailureItem[];
  initialSelectedIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const eligibleIds = useMemo(
    () => failures.flatMap((item) => (item.symlinkStatus === "eligible" && item.mediaLinkId ? [item.mediaLinkId] : [])),
    [failures]
  );
  const [selectedIds, setSelectedIds] = useState(
    () => new Set(initialSelectedIds.filter((id) => eligibleIds.includes(id)))
  );
  const [cleanupJobId, setCleanupJobId] = useState<number | null>(null);
  const cleanup = useMutation({
    mutationFn: (mediaLinkIds: number[]) => api.removeFailedCopySymlinks(sourceJobId, mediaLinkIds),
    onSuccess: (result) => {
      setCleanupJobId(result.jobId);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });
  const cleanupJob = useQuery({
    queryKey: ["job", cleanupJobId],
    queryFn: () => api.job(cleanupJobId!),
    enabled: Boolean(cleanupJobId),
    refetchInterval: (query: { state: { data?: JobRecord } }) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : false;
    }
  });
  const cleanupTerminal = cleanupJob.data && cleanupJob.data.status !== "queued" && cleanupJob.data.status !== "running";
  useEffect(() => {
    if (!cleanupTerminal) return;
    queryClient.invalidateQueries({ queryKey: ["copy-failures", sourceJobId] });
    queryClient.invalidateQueries({ queryKey: ["job-events", sourceJobId] });
    invalidateCopyJobData(queryClient);
  }, [cleanupTerminal, queryClient, sourceJobId]);
  const dialogRef = useModalLifecycle(true, onClose);
  const selectedCount = selectedIds.size;
  const allSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selectedIds.has(id));
  const progress = recordFromUnknown(cleanupJob.data?.progress);

  function toggleItem(mediaLinkId: number) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(mediaLinkId)) next.delete(mediaLinkId);
      else next.add(mediaLinkId);
      return next;
    });
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !cleanup.isPending) onClose();
      }}
    >
      <section ref={dialogRef} className="audit-dialog failed-symlink-cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="failed-symlink-cleanup-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Copy job #{sourceJobId}</span>
            <h2 id="failed-symlink-cleanup-title">Remove failed-copy symlinks</h2>
            <p>Review the exact managed links before queuing a cleanup worker.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close failed symlink cleanup" onClick={onClose} disabled={cleanup.isPending}>
            <X size={18} />
          </button>
        </div>

        {cleanupJobId ? (
          <div className="failed-symlink-cleanup-status" role="status">
            <div>
              <strong>Cleanup job #{cleanupJobId}</strong>
              <StatusPill value={cleanupJob.data?.status ?? "queued"} />
            </div>
            <p>{typeof progress?.message === "string" ? progress.message : cleanupJob.isLoading ? "Loading cleanup status..." : "Cleanup is queued."}</p>
            {progress ? (
              <dl>
                <div><dt>Removed</dt><dd>{formatNumber(finiteNumberFromUnknown(progress.removed))}</dd></div>
                <div><dt>Already missing</dt><dd>{formatNumber(finiteNumberFromUnknown(progress.alreadyMissing))}</dd></div>
                <div><dt>Failed</dt><dd>{formatNumber(finiteNumberFromUnknown(progress.failed))}</dd></div>
              </dl>
            ) : null}
            {cleanupJob.error ? <p className="action-error">{cleanupJob.error.message}</p> : null}
          </div>
        ) : (
          <>
            <div className="terminate-dialog-warning">
              <TriangleAlert size={18} />
              <div>
                <strong>Only the selected symlinks will be unlinked.</strong>
                <span>Source media, copied media, title folders, and parent directories will not be deleted. Plex may need its normal library scan before entries disappear.</span>
              </div>
            </div>
            <div className="failed-symlink-cleanup-toolbar">
              <strong>{formatNumber(selectedCount)} of {formatNumber(eligibleIds.length)} removable selected</strong>
              <button
                type="button"
                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(eligibleIds))}
                disabled={eligibleIds.length === 0}
              >
                {allSelected ? "Clear all" : "Select all removable"}
              </button>
            </div>
            <ul className="failed-symlink-cleanup-list">
              {failures.map((item) => {
                const eligible = item.symlinkStatus === "eligible" && item.mediaLinkId != null;
                return (
                  <li key={item.key} className={eligible ? "is-eligible" : "is-blocked"}>
                    <label>
                      <input
                        type="checkbox"
                        checked={eligible && selectedIds.has(item.mediaLinkId!)}
                        disabled={!eligible}
                        onChange={() => eligible && toggleItem(item.mediaLinkId!)}
                      />
                      <span>
                        <strong>{item.itemName}</strong>
                        {item.fileName ? <small>{item.fileName}</small> : null}
                      </span>
                    </label>
                    <div>
                      <StatusPill value={failedSymlinkStatusLabel(item)} />
                      <small>{item.symlinkStatusDetail}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
            {cleanup.error ? <p className="panel-message action-error">{cleanup.error.message}</p> : null}
          </>
        )}

        <div className="terminate-dialog-actions">
          <button type="button" onClick={onClose} disabled={cleanup.isPending}>{cleanupJobId ? "Close" : "Cancel"}</button>
          {!cleanupJobId ? (
            <button
              type="button"
              className="danger-button"
              onClick={() => cleanup.mutate([...selectedIds])}
              disabled={cleanup.isPending || selectedCount === 0}
            >
              <Trash2 size={15} />
              {cleanup.isPending ? "Queuing cleanup..." : `Remove ${formatNumber(selectedCount)} symlink${selectedCount === 1 ? "" : "s"}`}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function CopyItemDetailsTooltip({
  count,
  kind,
  items,
  loading,
  error,
  toolbar,
  itemControls
}: {
  count: number;
  kind: "completed" | "failed";
  items: CopyItemDetail[];
  loading: boolean;
  error?: string | null;
  toolbar?: ReactNode;
  itemControls?: (item: CopyItemDetail) => ReactNode;
}) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const unidentified = Math.max(0, count - items.length);
  const open = hovered || pinned;
  const kindLabel = kind === "failed" ? "Failed" : "Completed";
  const itemLabel = `${kind === "failed" ? "failed" : "completed"} item${count === 1 ? "" : "s"}`;
  const unidentifiedLabel = `${kind === "failed" ? "failed" : "completed"} item${unidentified === 1 ? "" : "s"}`;
  const heading = `${kindLabel} item${count === 1 ? "" : "s"}`;
  const Icon = kind === "failed" ? TriangleAlert : CheckCircle2;

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
      className={`copy-item-details-tooltip copy-item-details-${kind}${open ? " is-open" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => !pinned && setHovered(false)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && !pinned && setHovered(false)}
    >
      <button type="button" aria-label={`View ${formatNumber(count)} ${itemLabel}`} aria-controls={tooltipId} aria-expanded={open} onClick={togglePinned} onFocus={() => setHovered(true)}>
        <strong>{formatNumber(count)}</strong>
        <span>{kind === "failed" ? "Failed" : "Symlinked"}</span>
        <small>
          <ListChecks size={12} />
          View {itemLabel}
        </small>
      </button>
      <div id={tooltipId} className="copy-item-details-tooltip-panel" role="region" aria-label={`${kindLabel} item details`} aria-hidden={!open}>
        <div className="copy-item-details-tooltip-heading">
          <span>
            <Icon size={14} />
            <strong>{heading}</strong>
          </span>
          <button type="button" className="copy-item-details-tooltip-close" aria-label={`Close ${kind === "failed" ? "failed" : "completed"} item details`} onClick={close}>
            <X size={14} />
          </button>
        </div>
        {toolbar}
        {items.length > 0 ? (
          <ul className="copy-item-details-tooltip-list">
            {items.map((item) => (
              <li key={item.key} className={itemControls ? "has-actions" : undefined}>
                <div className="copy-item-details-copy">
                  <strong>{item.title}</strong>
                  {item.fileName ? <span>{item.fileName}</span> : null}
                  <small>{item.detail}</small>
                  {item.statusDetail ? <small className="copy-item-details-status">{item.statusDetail}</small> : null}
                </div>
                {itemControls?.(item)}
              </li>
            ))}
          </ul>
        ) : null}
        {loading ? <p>Loading {itemLabel} details...</p> : null}
        {error ? <p className="copy-item-details-tooltip-error">{kindLabel} item details could not be loaded.</p> : null}
        {!loading && !error && unidentified > 0 ? <p>{formatNumber(unidentified)} {unidentifiedLabel}{unidentified === 1 ? " was" : " were"} not identified by an item-level event.</p> : null}
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

export function OrphanPurgeProgressPanel({
  job,
  pendingJobId,
  compact = false
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  compact?: boolean;
}) {
  const { timeFormat } = useUserPreferences();
  const progress = orphanPurgeProgressFromJob(job);
  const statusLabel = orphanPurgeStageLabel(progress, job?.status);
  const percent = orphanPurgeProgressPercent(job, progress);
  const active = job?.status === "queued" || job?.status === "running";
  // The job writes the file it is on, then "N of M processed" once it is done, so the last file seen is kept.
  const reportedFile = orphanPurgeCurrentFile(progress);
  const [lastFile, setLastFile] = useState<string | null>(reportedFile);
  useEffect(() => {
    if (reportedFile) setLastFile(reportedFile);
  }, [reportedFile]);
  const currentFile = active ? reportedFile ?? lastFile : null;
  const countLabel = progress.total > 0 ? `${formatNumber(progress.current)} / ${formatNumber(progress.total)}` : pendingJobId ? "Waiting for purge progress" : "Not started";
  const detail = currentFile && progress.message === `Checking ${currentFile}` ? (progress.mode === "hold" ? "Moving to the holding area" : "Deleting") : progress.message ?? (active ? "Waiting for worker progress." : "No progress recorded.");
  const unit = progress.damaged ? "Damaged files" : "Orphans";
  return (
    <div className={`audit-progress-panel copy-progress-panel mobile-progress-panel${compact ? " compact" : ""}`} role="group" aria-label="Purge progress">
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
            <span>{unit} processed</span>
            <strong>{percent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track" role="progressbar" aria-label="Purge progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file">
        <File size={15} />
        <span>
          <strong>{currentFile ?? (active && progress.stage !== "rechecking" ? "Waiting for the next file" : statusLabel)}</strong>
          <small>{detail}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats mobile-progress-stats">
        <span>
          <strong>{formatNumber(progress.deleted)}</strong>
          Deleted
        </span>
        <span>
          <strong>{formatNumber(progress.held)}</strong>
          Held
        </span>
        <span>
          <strong>{formatNumber(progress.alreadyMissing)}</strong>
          Already missing
        </span>
        <span className={progress.failed > 0 ? "copy-progress-stat-bad" : undefined}>
          <strong>{formatNumber(progress.failed)}</strong>
          Failed
        </span>
        {progress.resurfacedDeleted > 0 ? (
          <span>
            <strong>{formatNumber(progress.resurfacedDeleted)}</strong>
            Resurfaced copy deleted
          </span>
        ) : null}
        {progress.keepsComingBack > 0 ? (
          <span className="copy-progress-stat-bad">
            <strong>{formatNumber(progress.keepsComingBack)}</strong>
            Keeps coming back
          </span>
        ) : null}
        {progress.cameBack > 0 || progress.recheck ? (
          <span className={progress.cameBack > 0 ? "copy-progress-stat-bad" : undefined}>
            <strong>{formatNumber(progress.cameBack)}</strong>
            Came back
          </span>
        ) : null}
        {progress.listedNotReadable > 0 ? (
          <span title="Deleted, but storage still lists them although they cannot be opened. Scans do not count them.">
            <strong>{formatNumber(progress.listedNotReadable)}</strong>
            Listed, not readable
          </span>
        ) : null}
        <span>
          <strong>{formatNumber(progress.remaining)}</strong>
          Left to do
        </span>
        <span>
          <strong>{orphanPurgeRateLabel(job, progress)}</strong>
          Rate
        </span>
        <span>
          <strong>{copyElapsedLabel(job)}</strong>
          Running
        </span>
        <span>
          <strong>{orphanPurgeRemainingLabel(job, progress)}</strong>
          Time remaining
        </span>
      </div>
      {progress.firstError ? (
        <p className="panel-message action-error purge-first-error">
          <strong>First error:</strong> <span title={progress.firstError.filePath}>{basenameFromPath(progress.firstError.filePath) ?? progress.firstError.filePath}</span>: {progress.firstError.message}
        </p>
      ) : null}
      {progress.firstCameBack ? (
        <p className="panel-message action-error purge-first-error">
          <strong>Came back:</strong> <span title={progress.firstCameBack.filePath}>{basenameFromPath(progress.firstCameBack.filePath) ?? progress.firstCameBack.filePath}</span>: {progress.firstCameBack.message}
        </p>
      ) : null}
      {progress.recheck && !compact ? <p className="panel-message purge-recheck-note">{orphanPurgeRecheckText(progress, active, timeFormat)}</p> : null}
    </div>
  );
}

function orphanPurgeRecheckText(progress: ReturnType<typeof orphanPurgeProgressFromJob>, active: boolean, timeFormat: TimeFormatPreference): string {
  const recheck = progress.recheck!;
  const items = recheck.total === 1 ? "1 deleted remote item" : `${formatNumber(recheck.total)} deleted remote items`;
  const delay = recheck.delaySeconds >= 120 ? `${Math.round(recheck.delaySeconds / 60)} minutes` : `${recheck.delaySeconds} seconds`;
  if (active && progress.stage === "rechecking" && Date.parse(recheck.at) > Date.now()) {
    return `Storage can bring a deleted file back by itself, so ${items} will be checked again at ${formatDate(recheck.at, timeFormat)}, ${delay} after the last delete.`;
  }
  if (active && progress.stage === "rechecking") return `Checking ${items} again: ${formatNumber(recheck.checked)} done.`;
  const checked = recheck.checked < recheck.total ? `${formatNumber(recheck.checked)} of ${items}` : items;
  return `Checked ${checked} again ${delay} after the last delete. ${progress.cameBack > 0 ? `${formatNumber(progress.cameBack)} came back and ${progress.cameBack === 1 ? "is" : "are"} not counted as deleted.` : "None came back."}`;
}

function purgeItemStageText(item: OrphanPurgeItem, timeFormat: TimeFormatPreference): string {
  if (item.stage === "deleted" || (item.stage === "came_back" && !item.errorMessage)) return item.note ?? "Deleted";
  if (item.stage === "held") return item.purgeAfter ? `Held until ${formatDate(item.purgeAfter, timeFormat)}` : "Held";
  if (item.stage === "restored") return "Restored from the holding area";
  if (item.stage === "expired") return "Holding period ended, deleted";
  return item.errorMessage ?? "No reason recorded";
}

const purgeItemsLabels: Record<OrphanPurgeItemOutcome, string> = {
  failed: "Failed items",
  held: "Held items",
  came_back: "Came back after the delete",
  keeps_coming_back: "Keeps coming back",
  resurfaced: "Deleted again after another copy appeared"
};

function OrphanPurgeItemsSection({
  jobId,
  outcome,
  count,
  active,
  rootType
}: {
  jobId: number;
  outcome: OrphanPurgeItemOutcome;
  count: number;
  active: boolean;
  rootType: "local" | "remote";
}) {
  const { timeFormat } = useUserPreferences();
  const { can } = useAccess();
  const items = useInfiniteQuery({
    queryKey: ["purge-job-items", jobId, outcome],
    queryFn: ({ pageParam }) => api.purgeJobItems(jobId, { outcome, offset: pageParam, limit: 100 }),
    initialPageParam: 0,
    getNextPageParam: (page) => (page.hasMore ? page.offset + page.items.length : undefined),
    enabled: count > 0,
    refetchInterval: active ? 2500 : false
  });
  if (count <= 0) return null;
  const rows = items.data?.pages.flatMap((page) => page.items) ?? [];
  const total = items.data?.pages[0]?.total ?? count;
  const failed = outcome === "failed";
  const cameBack = outcome === "came_back";
  const keeps = outcome === "keeps_coming_back";
  const resurfaced = outcome === "resurfaced";
  const problem = failed || cameBack || keeps;
  const label = purgeItemsLabels[outcome];
  return (
    <section className="audit-result-summary purge-items" aria-label={label}>
      <div className="audit-dialog-section-title">
        <span className="audit-dialog-section-label">
          {problem ? <TriangleAlert size={15} /> : <Archive size={15} />}
          <span>{label}</span>
        </span>
        <span className="job-events-heading-actions">
          <small>{rows.length < total ? `${formatNumber(rows.length)} of ${formatNumber(total)}` : formatNumber(total)}</small>
          {outcome === "held" && can("library.delete") ? (
            <Link to="/library" search={{ view: orphanPurgeHoldingAreaView(rootType), held: true }} className="secondary job-events-full-link">
              <Archive size={13} />
              Open holding area
            </Link>
          ) : null}
        </span>
      </div>
      {items.isLoading ? <p className="panel-message">Loading {label.toLowerCase()}...</p> : null}
      {items.error ? <p className="panel-message action-error">{items.error.message}</p> : null}
      {rows.length > 0 ? (
        <div className="audit-result-list" role="list" aria-label={label}>
          {rows.map((item) => (
            <article className="audit-result-item purge-item" role="listitem" key={item.operationId}>
              <div>
                <strong title={item.filePath}>{basenameFromPath(item.filePath) ?? item.filePath}{item.targetKind === "folder" ? " (folder)" : ""}</strong>
                <small className="purge-item-path" title={item.filePath}>{item.filePath}</small>
                <small className={problem ? "purge-item-reason" : undefined}>{purgeItemStageText(item, timeFormat)}</small>
              </div>
              {failed ? <StatusPill value="Failed" /> : cameBack ? <span className="pill pill-warning">Came back</span> : keeps ? <span className="pill pill-warning">Keeps coming back</span> : resurfaced ? <span className="pill pill-info">{`Deleted ${item.deleteRounds} times`}</span> : <span className={`pill ${item.stage === "held" ? "pill-info" : "pill-cancelled"}`}>{item.stage === "held" ? "Held" : item.stage === "restored" ? "Restored" : "Deleted"}</span>}
            </article>
          ))}
        </div>
      ) : null}
      {items.hasNextPage ? (
        <button className="secondary" type="button" disabled={items.isFetchingNextPage} onClick={() => void items.fetchNextPage()}>
          {items.isFetchingNextPage ? "Loading more..." : failed ? "Load more failed items" : outcome === "held" ? "Load more held items" : `Load more: ${label.toLowerCase()}`}
        </button>
      ) : null}
    </section>
  );
}

export function OrphanPurgeStatusDialog({
  prompt,
  onClose
}: {
  prompt: OrphanPurgeStatusPrompt | null;
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
    refetchInterval: (query: { state: { data?: JobRecord } }) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" || !status ? 1000 : false;
    }
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  // A purge logs one event per file, so only the newest page is loaded here; the full log is one click away.
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 1000 : false });
  const dialogRef = useModalLifecycle(Boolean(prompt), onClose);

  if (!prompt) return null;

  const progress = orphanPurgeProgressFromJob(currentJob);
  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="purge-status-dialog-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="purge-status-dialog-title">{prompt.title}</h2>
            <p>{`Job #${prompt.jobId} - ${currentJob ? orphanPurgeScopeText(currentJob) : prompt.description}`}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close purge status window" onClose={onClose} />
        </div>

        {jobQuery.error ? <p className="panel-message action-error">{jobQuery.error.message}</p> : null}

        <OrphanPurgeProgressPanel key={jobId ?? 0} job={currentJob} pendingJobId={jobId} />

        {jobId ? <OrphanPurgeItemsSection jobId={jobId} outcome="failed" count={progress.failed} active={jobActive} rootType={progress.rootType} /> : null}
        {jobId ? <OrphanPurgeItemsSection jobId={jobId} outcome="keeps_coming_back" count={progress.keepsComingBack} active={jobActive} rootType={progress.rootType} /> : null}
        {jobId ? <OrphanPurgeItemsSection jobId={jobId} outcome="came_back" count={progress.cameBack} active={jobActive} rootType={progress.rootType} /> : null}
        {jobId ? <OrphanPurgeItemsSection jobId={jobId} outcome="resurfaced" count={progress.resurfacedDeleted} active={jobActive} rootType={progress.rootType} /> : null}
        {jobId ? <OrphanPurgeItemsSection jobId={jobId} outcome="held" count={progress.held} active={jobActive} rootType={progress.rootType} /> : null}

        <div className="audit-dialog-events">
          <JobEventsHeader label="Purge events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading purge events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {jobActive ? <p className="panel-message">Closing this window leaves the purge running in the background.</p> : null}
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
    const selectedCount = job.selection?.total ?? options.linkIds?.length ?? 0;
    const sectionText = selectedCount > 0 ? (selectedCount === 1 ? "1 selected link" : `${formatNumber(selectedCount)} selected links`) : formatAuditScope(options, sections);
    const modeText = options.mode === "fast" ? "Fast audit" : options.mode === "deep" ? "Deep audit" : "Audit";
    const selectedLinkIds = options.linkIds ?? [];
    return (
      <span className="job-scope-cell" title={selectedCount > 0 ? undefined : sectionText}>
        <span>{modeText}</span>
        <JobScopeDetail text={sectionText} selection={job.selection} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "copy") {
    const options = copyOptionsFromJob(job);
    const directionText = `Copy to ${storageLocationName(storageLocations, options?.direction === "to_remote" ? "remote" : "local")}`;
    const selectedLinkIds = options?.linkIds ?? [];
    const selectedCount = job.selection?.total ?? selectedLinkIds.length;
    const workTotal = copyWorkTotalFromJob(job, selectedCount);
    const sectionText = selectedCount > 0
      ? workTotal === 1 ? "1 selected link" : `${formatNumber(workTotal)} selected links`
      : formatCopyScope(options, sections);
    return (
      <span className="job-scope-cell" title={selectedCount > 0 ? undefined : sectionText}>
        <span>{directionText}</span>
        <JobScopeDetail text={sectionText} selection={job.selection} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "orphan_purge") {
    return (
      <span className="job-scope-cell">
        <span>{orphanPurgeScopeText(job)}</span>
      </span>
    );
  }

  if (job.type === "orphan_restore") {
    const options = recordFromUnknown(job.options) ?? recordFromUnknown(recordFromUnknown(job.progress)?.options);
    const total = finiteNumberFromUnknown(options?.total);
    return (
      <span className="job-scope-cell">
        <span>{total === 1 ? "1 held file" : `${formatNumber(total)} held files`}</span>
        <small>From the holding area</small>
      </span>
    );
  }

  if (job.type === "partial_copy_discard") {
    const options = recordFromUnknown(job.options) ?? recordFromUnknown(recordFromUnknown(job.progress)?.options);
    const operationId = finiteNumberFromUnknown(options?.operationId);
    const copyJobId = finiteNumberFromUnknown(options?.copyJobId);
    return (
      <span className="job-scope-cell">
        <span>{operationId > 0 ? `Copy operation #${operationId}` : "Copy operation"}</span>
        <small>{copyJobId > 0 ? `Left by copy job #${copyJobId}` : "Interrupted copy"}</small>
      </span>
    );
  }

  if (job.type === "symlink_cleanup") {
    const progress = recordFromUnknown(job.progress);
    const options = recordFromUnknown(job.options) ?? recordFromUnknown(progress?.options) ?? progress;
    const sourceJobId = finiteNumberFromUnknown(options?.sourceJobId);
    const selectedLinkIds = job.selection?.linkIds ?? [];
    const selectedCount = job.selection?.total ?? selectedLinkIds.length;
    const detail = sourceJobId > 0 ? `Failed items from copy job #${sourceJobId}` : "Failed copy items";
    return (
      <span className="job-scope-cell">
        <span>{selectedCount === 1 ? "1 failed-copy symlink" : `${formatNumber(selectedCount)} failed-copy symlinks`}</span>
        <JobScopeDetail text={detail} selection={job.selection} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "watch_sync") {
    const options = recordFromUnknown(job.options) ?? recordFromUnknown(recordFromUnknown(job.progress)?.options);
    const pairs = Array.isArray(options?.pairIds) ? options.pairIds.length : 0;
    const mode = options?.mode === "preview" ? "Preview" : options?.mode === "restore" ? "Restore" : "Full reconciliation";
    return (
      <span className="job-scope-cell">
        <span>{mode}</span>
        <small>{pairs === 1 ? "1 user pair" : `${formatNumber(pairs)} user pairs`}</small>
      </span>
    );
  }

  if (job.type === "backup") {
    const options = recordFromUnknown(job.options) ?? recordFromUnknown(recordFromUnknown(job.progress)?.options);
    return (
      <span className="job-scope-cell">
        <span>Database</span>
        <small>{options?.trigger === "scheduled" ? "Scheduled" : "Started manually"}</small>
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
  selection,
  selectedLinkIds,
  linkRowsById,
  linkRowsLoading,
  linkRowsError
}: {
  text: string;
  selection?: JobSelectionSummary;
  selectedLinkIds: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  linkRowsLoading?: boolean;
  linkRowsError?: string | null;
}) {
  if (selection && selection.total > 0) {
    const snapshotSummaries = selection.titles.map((title) =>
      selection.titles.length > 1 && title.count > 1 ? `${title.itemName} (${formatNumber(title.count)} links)` : title.itemName
    );
    if (selection.omittedTitles) snapshotSummaries.push(`${formatNumber(selection.omittedTitles)} additional title${selection.omittedTitles === 1 ? "" : "s"}`);
    if (selection.unavailable > 0) snapshotSummaries.push(`${formatNumber(selection.unavailable)} unavailable historical link${selection.unavailable === 1 ? "" : "s"}`);
    if (selection.total === 1 && selection.titles.length === 1 && selection.unavailable === 0) {
      return <small title={selection.titles[0]?.itemName}>{selection.titles[0]?.itemName}</small>;
    }
    return (
      <small className="job-scope-detail-line">
        <span>{text}</span>
        <SelectedLinkTitlesTooltip summaries={snapshotSummaries} />
      </small>
    );
  }
  if (selectedLinkIds.length === 0) return <small>{text}</small>;
  const singleTitle = selectedLinkIds.length === 1 && !linkRowsLoading && !linkRowsError ? singleSelectedLinkTitle(selectedLinkIds, linkRowsById) : null;
  if (singleTitle) return <small title={singleTitle}>{singleTitle}</small>;
  const canShowTitleLookup = Boolean(linkRowsById || linkRowsLoading || linkRowsError);
  return (
    <small className="job-scope-detail-line">
      <span>{text}</span>
      {canShowTitleLookup ? <SelectedLinkTitlesTooltip linkIds={selectedLinkIds} linkRowsById={linkRowsById} isLoading={linkRowsLoading} error={linkRowsError} /> : null}
    </small>
  );
}

function SelectedLinkTitlesTooltip({
  summaries: suppliedSummaries,
  linkIds,
  linkRowsById,
  isLoading,
  error
}: {
  summaries?: string[];
  linkIds?: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  isLoading?: boolean;
  error?: string | null;
}) {
  const detailsId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = pinned || (!dismissed && (hovered || focusWithin));
  const summaries = suppliedSummaries ?? selectedLinkTitleSummaries(linkIds ?? [], linkRowsById);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setDismissed(true);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setDismissed(true);
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`job-link-title-tooltip${open ? " is-open" : ""}`}
      onMouseEnter={() => {
        setHovered(true);
        if (!rootRef.current?.contains(document.activeElement)) setDismissed(false);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(true);
          setDismissed(false);
        }
      }}
      onBlurCapture={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
          setDismissed(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="job-link-title-tooltip-trigger"
        aria-label="View selected titles"
        aria-controls={detailsId}
        aria-expanded={open}
        onClick={() => {
          if (pinned) {
            setPinned(false);
            setDismissed(true);
          } else {
            setPinned(true);
            setDismissed(false);
          }
        }}
      >
        <Info size={12} />
      </button>
      <span id={detailsId} className="job-link-title-tooltip-panel" role="region" aria-label="Selected titles" aria-hidden={!open}>
          <span className="job-link-title-tooltip-heading">
            <strong>Selected titles</strong>
            <button type="button" className="job-link-title-tooltip-close" aria-label="Close selected titles" tabIndex={open ? 0 : -1} onClick={() => {
              setPinned(false);
              setDismissed(true);
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}>
              <X size={13} />
            </button>
          </span>
          {isLoading ? <span>Loading titles...</span> : null}
          {!isLoading && error ? <span>{error}</span> : null}
          {!isLoading && !error && summaries.length === 0 ? <span>No matching titles found in the current inventory.</span> : null}
          {!isLoading && !error && summaries.length > 0 ? (
            <ul>
              {summaries.map((title, index) => (
                <li key={`${index}:${title}`}>{title}</li>
              ))}
            </ul>
          ) : null}
      </span>
    </span>
  );
}

/**
 * Runs a finished copy job's failed items again as a new job. One click, unless the original job removed files:
 * then a dialog asks first, and nothing is removed unless it is ticked. The server applies the same rules.
 */
export function CopyRetryAction({ job, compact = false, onStarted }: { job: JobRecord | null; compact?: boolean; onStarted?: (started: CopyRetryStarted) => void }) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [started, setStarted] = useState<CopyRetryStarted | null>(null);
  const jobId = job?.id ?? null;
  const finishedWithFailures = job?.type === "copy" && (job.status === "failed" || job.status === "partially_failed");
  const planQuery = useQuery({
    queryKey: ["copy-retry", jobId],
    queryFn: () => api.copyRetryPlan(jobId!),
    enabled: finishedWithFailures,
    staleTime: 2_000,
    refetchInterval: 10_000
  });
  // A double click lands both clicks before `isPending` has rendered.
  const pressed = useRef(false);
  const retry = useMutation({
    mutationFn: (choices: { replaceExisting?: boolean; deleteRemoteSources?: boolean }) => api.retryFailedCopies(jobId!, choices),
    onSuccess: (result) => {
      setOptionsOpen(false);
      setStarted(result);
      onStarted?.(result);
    },
    onSettled: () => {
      pressed.current = false;
      invalidateCopyJobData(queryClient);
    }
  });
  const startRetry = (choices: { replaceExisting?: boolean; deleteRemoteSources?: boolean }) => {
    if (pressed.current) return;
    pressed.current = true;
    retry.mutate(choices);
  };
  const plan = planQuery.data;
  if (!finishedWithFailures || !plan || plan.totalFailed === 0) return null;
  if (!can(plan.direction === "to_remote" ? "library.manage" : "copies.to_local")) return null;

  const canDelete = can("library.delete");
  const needsOptions = plan.replaceOffered || (plan.deleteRemoteSourceOffered && canDelete);
  const hasWork = plan.retryCount > 0;
  const itemLabel = `${formatNumber(plan.retryCount)} failed item${plan.retryCount === 1 ? "" : "s"}`;
  const buttonClass = compact ? "table-action-button secondary copy-retry-button" : "status-terminate-button secondary copy-retry-button";
  const note = retry.error ? null : started && !onStarted ? copyRetryStartedMessage(started) : !compact || (!hasWork && reasonsOpen) ? plan.summary : null;

  return (
    <div className={compact ? "copy-retry-action compact" : "status-title-actions copy-retry-action"}>
      {hasWork ? (
        <button
          type="button"
          className={buttonClass}
          aria-label={`Retry ${itemLabel} from job #${plan.jobId}`}
          title={plan.summary || `Retry ${itemLabel} as a new job`}
          disabled={retry.isPending}
          onClick={() => (needsOptions ? setOptionsOpen(true) : startRetry({}))}
        >
          <RotateCcw size={15} />
          <span>{retry.isPending ? "Retrying..." : `Retry failed (${formatNumber(plan.retryCount)})`}</span>
        </button>
      ) : (
        <button
          type="button"
          className={`${buttonClass} nothing-to-retry`}
          // The list has no room to keep the reasons open, so this opens them. The job's page always shows them.
          disabled={!compact}
          aria-expanded={compact ? reasonsOpen : undefined}
          aria-label={`Nothing to retry from job #${plan.jobId}`}
          title={plan.summary}
          onClick={() => setReasonsOpen((open) => !open)}
        >
          <RotateCcw size={15} />
          <span>Nothing to retry</span>
        </button>
      )}
      {note ? <small className="copy-retry-note" role="status">{note}</small> : null}
      {retry.error && !optionsOpen ? <small className="copy-retry-note action-error" role="alert">{retry.error.message}</small> : null}
      {optionsOpen
        ? createPortal(
            <CopyRetryOptionsDialog
              plan={plan}
              canDelete={canDelete}
              error={retry.error?.message}
              isPending={retry.isPending}
              onClose={() => {
                if (retry.isPending) return;
                setOptionsOpen(false);
                retry.reset();
              }}
              onConfirm={startRetry}
            />,
            document.body
          )
        : null}
    </div>
  );
}

function CopyRetryOptionsDialog({
  plan,
  canDelete,
  error,
  isPending,
  onClose,
  onConfirm
}: {
  plan: CopyRetryPlan;
  canDelete: boolean;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (choices: { replaceExisting: boolean; deleteRemoteSources: boolean }) => void;
}) {
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [deleteRemoteSources, setDeleteRemoteSources] = useState(false);
  const dialogRef = useModalLifecycle(true, onClose);
  const itemLabel = `${formatNumber(plan.retryCount)} failed item${plan.retryCount === 1 ? "" : "s"}`;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog terminate-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-retry-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Retry failed items</span>
            <h2 id="copy-retry-title">Retry {itemLabel} from job #{plan.jobId}</h2>
            <p>{plan.summary || "These run as a new job. The original job stays as it is."}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close retry options" disabled={isPending}>
            <X size={18} />
          </button>
        </div>
        {plan.replaceOffered && !canDelete ? (
          <p className="panel-message">The original job replaced existing local files. Your retry will keep both, with the old file kept under a new name.</p>
        ) : null}
        {plan.replaceOffered && canDelete ? (
          <label className="copy-retry-option">
            <input type="checkbox" checked={replaceExisting} disabled={isPending} onChange={(event) => setReplaceExisting(event.target.checked)} />
            <span>
              <strong>Replace existing local files, as the original job did</strong>
              <small>This deletes the files already there. Left unticked, both files are kept, with the old one under a new name.</small>
            </span>
          </label>
        ) : null}
        {plan.deleteRemoteSourceOffered && canDelete ? (
          <label className="copy-retry-option">
            <input type="checkbox" checked={deleteRemoteSources} disabled={isPending} onChange={(event) => setDeleteRemoteSources(event.target.checked)} />
            <span>
              <strong>Delete remote sources after verified copies, as the original job did</strong>
              <small>Left unticked, the remote sources stay.</small>
            </span>
          </label>
        ) : null}
        {error ? <p className="panel-message action-error">{error}</p> : null}
        <div className="terminate-dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </button>
          <button type="button" disabled={isPending} onClick={() => onConfirm({ replaceExisting, deleteRemoteSources })}>
            <RotateCcw size={15} />
            <span>{isPending ? "Retrying..." : `Retry ${itemLabel}`}</span>
          </button>
        </div>
      </section>
    </div>
  );
}

export function JobsTable({
  jobs,
  sections,
  onScanJobSelect,
  onAuditJobSelect,
  onCopyJobSelect,
  onPurgeJobSelect
}: {
  jobs: JobRecord[];
  sections: Array<{ section: string; title?: string | null }>;
  onScanJobSelect?: (job: JobRecord) => void;
  onAuditJobSelect?: (job: JobRecord) => void;
  onCopyJobSelect?: (job: JobRecord) => void;
  onPurgeJobSelect?: (job: JobRecord) => void;
}) {
  const { canStopJob } = useAccess();
  const preferences = useUserPreferences();
  const { timeFormat } = preferences;
  const queryClient = useQueryClient();
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const saveRecentJobsFilter = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (savedPreferences) => {
      queryClient.setQueryData(["user-preferences"], savedPreferences);
    }
  });
  const completedWindowMinutes = normalizeRecentJobsCompletedWindowMinutes(preferences.recentJobsCompletedWindowMinutes);
  const visibleJobs = visibleDashboardJobs(jobs, completedWindowMinutes);
  const jobEntries = useMemo(() => groupAdjacentJobs(visibleJobs), [visibleJobs]);
  const selectedJobLinkIds = useMemo(() => selectedLinkIdsFromJobs(visibleJobs), [visibleJobs]);
  const selectedJobLinkRows = useQuery({
    queryKey: ["media-links-by-ids", selectedJobLinkIds],
    queryFn: () => api.mediaLinksByIds(selectedJobLinkIds),
    enabled: selectedJobLinkIds.length > 0,
    staleTime: 5000
  });
  const selectedJobLinkRowsById = useMemo(() => new Map((selectedJobLinkRows.data ?? []).map((link) => [link.id, link])), [selectedJobLinkRows.data]);
  const renderJobScope = (job: JobRecord) => (
    <JobScope
      job={job}
      sections={sections}
      linkRowsById={selectedJobLinkRowsById}
      linkRowsLoading={selectedJobLinkRows.isLoading || selectedJobLinkRows.isFetching}
      linkRowsError={selectedJobLinkRows.error?.message ?? null}
    />
  );
  const renderJobRow = (job: JobRecord, className?: string) => {
    const canViewScanJob = job.type === "scan" && Boolean(onScanJobSelect);
    const canViewAuditJob = job.type === "audit" && Boolean(onAuditJobSelect);
    const canViewCopyJob = job.type === "copy" && Boolean(onCopyJobSelect);
    const canViewPurgeJob = job.type === "orphan_purge" && Boolean(onPurgeJobSelect);
    const canTerminate = canTerminateJob(job) && canStopJob(job);
    const hasActions = canViewScanJob || canViewAuditJob || canViewCopyJob || canViewPurgeJob || canTerminate;
    return (
      <tr key={job.id} className={`mobile-card-row${className ? ` ${className}` : ""}`}>
        <td className="mobile-card-primary" data-label="ID">#{job.id}</td>
        <td className="mobile-card-detail" data-label="Type">{formatJobType(job.type)}</td>
        <td className="mobile-card-detail" data-label="Scope">
          {renderJobScope(job)}
        </td>
        <td className="mobile-card-status" data-label="Status">
          <StatusPill value={job.status} />
        </td>
        <td className="mobile-card-detail" data-label="Started">{formatDate(job.startedAt, timeFormat)}</td>
        <td className="mobile-card-detail" data-label="Finished">{formatDate(job.finishedAt, timeFormat)}</td>
        <td className="actions-cell mobile-card-actions" data-label="Actions">
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
            {canViewPurgeJob && onPurgeJobSelect ? (
              <button type="button" className="icon-button" title={`View purge status for job #${job.id}`} aria-label={`View purge status for job #${job.id}`} onClick={() => onPurgeJobSelect(job)}>
                <Search size={15} />
              </button>
            ) : null}
            <CopyRetryAction job={job} compact />
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
  };
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
        <table className="responsive-table mobile-card-table recent-jobs-table" aria-label="Recent jobs">
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
            {jobEntries.map((entry) => {
              if (entry.kind === "job") return renderJobRow(entry.job);
              const newest = entry.jobs[0];
              const expanded = expandedGroups.has(entry.key);
              const { summary } = entry;
              const groupLabel = `${summary.label} for ${formatJobType(newest.type)}`;
              return (
                <Fragment key={entry.key}>
                  <tr className={`mobile-card-row job-group-row${summary.failed > 0 ? " has-failures" : ""}`}>
                    <td className="mobile-card-primary" data-label="ID">
                      <button
                        type="button"
                        className="job-group-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${groupLabel}`}
                        onClick={() =>
                          setExpandedGroups((current) => {
                            const next = new Set(current);
                            if (!next.delete(entry.key)) next.add(entry.key);
                            return next;
                          })
                        }
                      >
                        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        <span>#{newest.id}</span>
                        <span className="job-group-count">×{summary.total}</span>
                      </button>
                    </td>
                    <td className="mobile-card-detail" data-label="Type">{formatJobType(newest.type)}</td>
                    <td className="mobile-card-detail" data-label="Scope">{renderJobScope(newest)}</td>
                    <td className="mobile-card-status" data-label="Status">
                      <StatusPill value={summary.failed > 0 ? "failed" : newest.status} />
                      {summary.note ? <small className="job-group-summary">{summary.note}</small> : null}
                    </td>
                    <td className="mobile-card-detail" data-label="Started">{formatDate(newest.startedAt, timeFormat)}</td>
                    <td className="mobile-card-detail" data-label="Finished">{formatDate(newest.finishedAt, timeFormat)}</td>
                    <td className="actions-cell mobile-card-actions" data-label="Actions">
                      <span className="muted-cell">{expanded ? "Showing each job" : "Expand for actions"}</span>
                    </td>
                  </tr>
                  {expanded ? entry.jobs.map((job) => renderJobRow(job, "job-group-child")) : null}
                </Fragment>
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
