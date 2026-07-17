import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowUp, Blocks, CheckCircle2, FileText, FolderCog, ListChecks, Plus, Radar, Search, ServerCog, Settings, TriangleAlert, UserCog } from "lucide-react";
import { api } from "./api";
import { copyBehaviorForProfile, defaultAdvancedSettings, normalizeAdvancedSettings } from "../shared/advancedSettings";
import { formatJobType, jobProgressChips, matchesEventFilters, matchesJobFilters, type EventLevelFilter, type JobStatusFilter, type JobTypeFilter } from "./logDisplay";
import { normalizeAuditTargets } from "./jobScopeLocks";
import { inventoryPolicyNeededCount } from "./sectionSummaryDisplay";
import { jobEventCountLabel } from "./jobEvents";
import { type AuditMode, type AuditRunRecord, type AdvancedSettings, type JobRecord, type CopyMediaValidationMode, type CopyVerificationProfile, type PathsSettings, type ScanOptions, type ScanRunRecord, type StorageLocationKey, type StorageLocationsSettings, type TimeFormatPreference, type UserPreferences } from "../shared/types";
import { LogChipList, Page, Panel, ScanProgressPanel, SectionDraftList, StatusPill } from "./App";
import { auditModeOptions, AuditStatusPrompt, copyPipelineLabels, copyProfileOptions, createEmptySectionDraft, defaultStorageLocations, defaultUserPreferences, formatDate, formatDuration, formatNumber, integrationPlaceholders, inventoryAssignedRemoteCount, inventoryCopyToLocalCount, inventoryCopyToRemoteCount, mediaValidationOptions, ScanStatusPrompt, SectionDraft, sectionDraftsToSettings, sectionSettingsToDrafts, SettingsView, storageLocationName, timeFormatOptions, useJobEventTimeline, useStorageLocations, useUserPreferences } from "./appShared";
import { AuditProgressPanel, AuditStatusDialog, CopyProgressPanel, JobScope, LogEventRow, ScanStatusDialog } from "./jobPresentation";
import { AuditScopeDisplayOptions, auditStatusPromptFromRun, countEventsByLevel, countJobsByStatus, countJobsByType, formatFolderScope, formatTitleScanScope, jobDurationLabel, scanStatusPromptFromRun } from "./jobPresentationUtils";

const logsRouteApi = getRouteApi("/logs");

export function RunsPage({ type }: { type: "scan" | "audit" }) {
  return type === "scan" ? <ScanHistoryPage /> : <AuditHistoryPage />;
}

function ScanHistoryPage() {
  const query = useQuery({ queryKey: ["scans"], queryFn: api.scans, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const availableSections = (sectionSettings.data?.sections ?? []).map((section) => ({ section, title: sectionSettings.data?.sectionTitles?.[section] ?? section }));
  return (
    <Page title="History > Scans" subtitle="Past inventory scans with scanned scope, resulting inventory counters, and failure details.">
      <ScanRunsList
        runs={query.data ?? []}
        availableSections={availableSections}
        isLoading={query.isLoading}
        error={query.error}
        onScanJobSelect={(run) => setScanStatusPrompt(scanStatusPromptFromRun(run, availableSections))}
      />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}

function AuditHistoryPage() {
  const query = useQuery({ queryKey: ["audits"], queryFn: api.audits, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [auditStatusPrompt, setAuditStatusPrompt] = useState<AuditStatusPrompt | null>(null);
  const availableSections = (sectionSettings.data?.sections ?? []).map((section) => ({ section, title: sectionSettings.data?.sectionTitles?.[section] ?? section }));
  return (
    <Page title="History > Audits" subtitle="Past audits with audited scope, validation results, and source comparison details.">
      <AuditRunsList
        runs={query.data ?? []}
        availableSections={availableSections}
        isLoading={query.isLoading}
        error={query.error}
        onAuditJobSelect={(run) => setAuditStatusPrompt(auditStatusPromptFromRun(run, availableSections))}
      />
      <AuditStatusDialog prompt={auditStatusPrompt} onClose={() => setAuditStatusPrompt(null)} />
    </Page>
  );
}

function ScanRunsList({
  runs,
  availableSections,
  isLoading,
  error,
  onScanJobSelect
}: {
  runs: ScanRunRecord[];
  availableSections: Array<{ section: string; title?: string | null }>;
  isLoading: boolean;
  error: Error | null;
  onScanJobSelect: (run: ScanRunRecord) => void;
}) {
  const { timeFormat } = useUserPreferences();
  const storageLocations = useStorageLocations();
  if (isLoading) return <p className="panel-message">Loading scan history...</p>;
  if (error) return <p className="panel-message error">{error.message}</p>;
  if (runs.length === 0) return <p className="panel-message">No scan history yet.</p>;

  return (
    <div className="scan-run-list">
      {runs.map((run) => {
        const options = run.options ?? null;
        const metricGroups = scanHistoryMetricGroups(run, options, storageLocations);
        const scopeItems = scanHistoryScopeItems(options, availableSections, storageLocations);
        return (
          <article className="scan-run-card" key={run.id ?? `job-${run.jobId}`}>
            <div className="scan-run-main">
              <div className="scan-run-title">
                <strong>{run.id == null ? `Scan job #${run.jobId}` : `Scan #${run.id}`}</strong>
                <span>{run.id == null ? "No scan run record was created" : `Job #${run.jobId}`}</span>
              </div>
              <div className="scan-run-actions">
                <StatusPill value={run.status} />
                <button type="button" className="icon-button" title={`View scan status for job #${run.jobId}`} aria-label={`View scan status for job #${run.jobId}`} onClick={() => onScanJobSelect(run)}>
                  <Search size={15} />
                </button>
              </div>
            </div>
            <div className="scan-run-meta">
              <span>Started {formatDate(run.startedAt, timeFormat)}</span>
              <span>Finished {formatDate(run.finishedAt, timeFormat)}</span>
              <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
            </div>
            <div className="scan-run-scope" aria-label="Scanned scope">
              <span className="scan-run-scope-label">Scanned</span>
              <div className="scan-run-scope-list">
                {scopeItems.map((item) => (
                  <span className="scan-run-scope-chip" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </span>
                ))}
              </div>
            </div>
            {run.errorMessage ? (
              <p className="scan-run-error">
                <TriangleAlert size={14} />
                <span>{run.errorMessage}</span>
              </p>
            ) : null}
            <div className="scan-run-groups">
              {metricGroups.map((group) => (
                <MetricGroup key={group.title} title={group.title} description={group.description} metrics={group.metrics} />
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

type MetricDefinition = { label: string; value: number | string };
type MetricGroupDefinition = { title: string; description?: string; metrics: MetricDefinition[] };

function scanHistoryScopeItems(
  options: Partial<ScanOptions> | null,
  availableSections: Array<{ section: string; title?: string | null }>,
  storageLocations: StorageLocationsSettings
): Array<{ label: string; value: string }> {
  if (!options) return [{ label: "Scope", value: "Unavailable" }];
  if (options.titleScopes?.length) {
    return [{ label: options.titleScopes.length === 1 ? "Title" : "Titles", value: formatTitleScanScope(options.titleScopes, availableSections) }];
  }
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const items: Array<{ label: string; value: string }> = [];
  if (options.scanSymlinks) items.push({ label: "Symlinks", value: formatFolderScope(options.symlinkSections ?? options.sections, availableSections) });
  if (options.scanLocal) items.push({ label: `${localName} files`, value: formatFolderScope(options.localSections ?? options.sections, availableSections) });
  if (options.scanRemote) items.push({ label: `${remoteName} files`, value: `${remoteName} root` });
  return items.length > 0 ? items : [{ label: "Scope", value: "No categories selected" }];
}

function scanHistoryPolicyMetrics(run: ScanRunRecord, options: Partial<ScanOptions> | null, storageLocations: StorageLocationsSettings): MetricDefinition[] {
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  if (!options) {
    return [
      { label: "Needs assignment", value: inventoryPolicyNeededCount(run) + run.unassignedRemoteFiles + run.unassignedLocalFiles },
      { label: `Needs ${localName} copy`, value: inventoryCopyToLocalCount(run) },
      { label: `Needs ${remoteName} copy`, value: inventoryCopyToRemoteCount(run) },
      { label: `${remoteName} policy`, value: inventoryAssignedRemoteCount(run) }
    ];
  }

  const needsAssignment =
    (options.scanSymlinks ? run.unassignedRemoteLinks + run.unassignedLocalLinks : 0) +
    (options.scanRemote ? run.unassignedRemoteFiles : 0) +
    (options.scanLocal ? run.unassignedLocalFiles : 0);
  const needsLocalCopy = (options.scanSymlinks ? run.actionableRemoteLinks : 0) + (options.scanRemote ? run.actionableRemoteFiles : 0);
  const needsRemoteCopy = (options.scanSymlinks ? run.actionableLocalLinks : 0) + (options.scanLocal ? run.actionableLocalFiles : 0);
  const assignedRemote = (options.scanSymlinks ? run.assignedRemoteLinks : 0) + (options.scanRemote ? run.assignedRemoteFiles : 0);

  return [
    { label: "Needs assignment", value: needsAssignment },
    { label: `Needs ${localName} copy`, value: needsLocalCopy },
    { label: `Needs ${remoteName} copy`, value: needsRemoteCopy },
    { label: `${remoteName} policy`, value: assignedRemote }
  ];
}

function scanHistoryMissingMetrics(run: ScanRunRecord, options: Partial<ScanOptions> | null): MetricDefinition[] {
  if (!options) {
    return [
      { label: "Symlinks", value: run.missingLinks },
      { label: "Local files", value: run.missingLocalFiles },
      { label: "Remote files", value: run.missingRemoteFiles }
    ];
  }

  const metrics: MetricDefinition[] = [];
  if (options.scanSymlinks) metrics.push({ label: "Symlinks", value: run.missingLinks });
  if (options.scanLocal) metrics.push({ label: "Local files", value: run.missingLocalFiles });
  if (options.scanRemote) metrics.push({ label: "Remote files", value: run.missingRemoteFiles });
  return metrics;
}

function scanHistoryMetricGroups(run: ScanRunRecord, options: Partial<ScanOptions> | null, storageLocations: StorageLocationsSettings): MetricGroupDefinition[] {
  const groups: MetricGroupDefinition[] = [];
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");

  if (!options || options.scanSymlinks) {
    const symlinkMetrics: MetricDefinition[] = [
      { label: "Total symlinks", value: run.totalLinks },
      { label: `Pointing to ${remoteName}`, value: run.remoteLinks },
      { label: `Pointing to ${localName}`, value: run.localLinks },
      { label: "Broken symlinks", value: run.brokenLinks }
    ];
    if (run.otherLinks > 0) symlinkMetrics.push({ label: "Other targets", value: run.otherLinks });
    if (run.nonMediaLinks > 0) symlinkMetrics.push({ label: "Non-media links", value: run.nonMediaLinks });
    groups.push({
      title: "Symlink inventory",
      description: options ? "Current symlink inventory after this scan." : "Inventory snapshot after this scan.",
      metrics: symlinkMetrics
    });
  }

  groups.push({
    title: "Policy state",
    description: "Current assignment and copy work inside the scanned scope.",
    metrics: scanHistoryPolicyMetrics(run, options, storageLocations)
  });

  if (!options || options.scanLocal) {
    groups.push({
      title: `${localName} file inventory`,
      description: options ? `Files found in the scanned ${localName} folders.` : `${localName} file inventory snapshot after this scan.`,
      metrics: [
        { label: "Files found", value: run.localFiles },
        { label: "Orphan files", value: run.localOrphanFiles }
      ]
    });
  }

  if (!options || options.scanRemote) {
    groups.push({
      title: `${remoteName} file inventory`,
      description: options ? `Files found under the scanned ${remoteName} root.` : `${remoteName} file inventory snapshot after this scan.`,
      metrics: [
        { label: "Files found", value: run.remoteFiles },
        { label: "Orphan files", value: run.remoteOrphanFiles }
      ]
    });
  }

  const missingMetrics = scanHistoryMissingMetrics(run, options);
  if (missingMetrics.some((metric) => typeof metric.value === "number" && metric.value > 0)) {
    groups.push({
      title: "No longer found",
      description: "Previously indexed paths in the scanned scope that were not seen in this run.",
      metrics: missingMetrics
    });
  }

  return groups;
}

function AuditRunsList({
  runs,
  availableSections,
  isLoading,
  error,
  onAuditJobSelect
}: {
  runs: AuditRunRecord[];
  availableSections: Array<{ section: string; title?: string | null }>;
  isLoading: boolean;
  error: Error | null;
  onAuditJobSelect: (run: AuditRunRecord) => void;
}) {
  const { timeFormat } = useUserPreferences();
  if (isLoading) return <p className="panel-message">Loading audit history...</p>;
  if (error) return <p className="panel-message error">{error.message}</p>;
  if (runs.length === 0) return <p className="panel-message">No audit history yet.</p>;

  return (
    <div className="scan-run-list">
      {runs.map((run) => {
        const options = run.options ?? null;
        const scopeItems = auditHistoryScopeItems(run, options, availableSections);
        const metricGroups = auditHistoryMetricGroups(run, options);
        return (
          <article className="scan-run-card" key={run.id}>
            <div className="scan-run-main">
              <div className="scan-run-title">
                <strong>Audit #{run.id}</strong>
                <span>
                  Job #{run.jobId} / {auditModeLabel(options?.mode ?? run.mode)}
                </span>
              </div>
              <div className="scan-run-actions">
                <StatusPill value={run.status} />
                <button type="button" className="icon-button" title={`View audit status for job #${run.jobId}`} aria-label={`View audit status for job #${run.jobId}`} onClick={() => onAuditJobSelect(run)}>
                  <ListChecks size={15} />
                </button>
              </div>
            </div>
            <div className="scan-run-meta">
              <span>Started {formatDate(run.startedAt, timeFormat)}</span>
              <span>Finished {formatDate(run.finishedAt, timeFormat)}</span>
              <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
            </div>
            <div className="scan-run-scope" aria-label="Audited scope">
              <span className="scan-run-scope-label">Audited</span>
              <div className="scan-run-scope-list">
                {scopeItems.map((item) => (
                  <span className="scan-run-scope-chip" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </span>
                ))}
              </div>
            </div>
            {run.errorMessage ? (
              <p className="scan-run-error">
                <TriangleAlert size={14} />
                <span>{run.errorMessage}</span>
              </p>
            ) : null}
            <div className="scan-run-groups">
              {metricGroups.map((group) => (
                <MetricGroup key={group.title} title={group.title} description={group.description} metrics={group.metrics} />
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function auditModeLabel(mode: AuditMode | null | undefined): string {
  if (mode === "deep") return "Deep";
  if (mode === "fast") return "Fast";
  return "Unknown";
}

function auditTargetLabel(options: AuditScopeDisplayOptions | null): string {
  if (!options) return "Unavailable";
  const targets = normalizeAuditTargets(options.targets);
  if (targets.length === 0) return "No targets";
  if (targets.includes("local") && targets.includes("remote")) return "Local + remote";
  return targets.includes("local") ? "Local" : "Remote";
}

function auditByteCompareLabel(options: AuditScopeDisplayOptions | null): string {
  if (!options) return "Unknown";
  return options.byteCompare === false ? "Skipped" : "Enabled";
}

function auditHistoryScopeItems(run: AuditRunRecord, options: AuditScopeDisplayOptions | null, availableSections: Array<{ section: string; title?: string | null }>): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [
    { label: "Mode", value: auditModeLabel(options?.mode ?? run.mode) },
    { label: "Targets", value: auditTargetLabel(options) },
    { label: "Byte compare", value: auditByteCompareLabel(options) }
  ];

  if (!options) {
    items.push({ label: "Scope", value: "Unavailable" });
    return items;
  }

  const targets = normalizeAuditTargets(options.targets);
  const hasScopedSelection = Boolean(options.linkIds?.length || options.section || options.itemName || options.relativePathPrefix);
  if (options.linkIds?.length) items.push({ label: "Selected links", value: `${formatNumber(options.linkIds.length)} selected` });
  if (options.itemName) items.push({ label: "Title", value: options.itemName });
  if (options.section) items.push({ label: "Folder", value: availableSections.find((section) => section.section === options.section)?.title ?? options.section });
  if (options.relativePathPrefix) items.push({ label: "Path scope", value: options.relativePathPrefix });

  if (!hasScopedSelection) {
    if (targets.includes("local")) items.push({ label: "Local folders", value: formatFolderScope(options.sections, availableSections) });
    if (targets.includes("remote")) items.push({ label: "Remote scope", value: "Remote root" });
  }

  return items;
}

function auditHistoryMetricGroups(run: AuditRunRecord, options: AuditScopeDisplayOptions | null): MetricGroupDefinition[] {
  const byteCompareSkipped = options?.byteCompare === false;
  const sourceComparisonMetrics: MetricDefinition[] = byteCompareSkipped
    ? [{ label: "Byte compare", value: "Skipped" }]
    : [
        { label: "No recorded source", value: run.sourceUnknown },
        { label: "Recorded source missing", value: run.sourceMissing },
        { label: "Source compare errors", value: run.sourceCompareErrors },
        { label: "Byte mismatches", value: run.byteMismatches }
      ];

  return [
    {
      title: "Media validation",
      description: `Files checked with the ${auditModeLabel(options?.mode ?? run.mode).toLowerCase()} audit mode. Failed total includes target validation failures, byte mismatches, and source comparison issues.`,
      metrics: [
        { label: "Checked", value: run.checked },
        { label: "Passed", value: run.passed },
        { label: "Failed total", value: run.failed },
        { label: "Target validation failures", value: run.targetValidationFailures }
      ]
    },
    {
      title: "Source comparison",
      description: byteCompareSkipped
        ? "Byte compare was skipped by audit settings; media validation still ran."
        : "Byte compare uses recorded source paths when available. No recorded source means the item was still media-validated, but bytes could not be compared.",
      metrics: sourceComparisonMetrics
    }
  ];
}

function MetricGroup({ title, description, metrics }: { title: string; description?: string; metrics: MetricDefinition[] }) {
  return (
    <section className="metric-group" aria-label={title}>
      <h3>{title}</h3>
      {description ? <p className="metric-group-description">{description}</p> : null}
      <dl>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{typeof metric.value === "number" ? formatNumber(metric.value) : metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function IntegrationsPage() {
  return (
    <Page title="Integrations" subtitle="Automation hooks and metadata-assisted workflows will land here.">
      <section className="coming-soon-panel">
        <div>
          <Blocks size={24} />
          <h2>Coming soon</h2>
          <p>Integration-driven workflows are not active yet. Connection settings live under Settings &gt; Integrations while this page is being built out.</p>
        </div>
        <Link to="/settings/integrations" className="button-link">
          <ServerCog size={16} />
          Open integration settings
        </Link>
      </section>
    </Page>
  );
}

function IntegrationSettingsPanel() {
  return (
    <>
      <p className="section-settings-help">Integration settings are placeholders until the adapters are built. These fields are intentionally disabled and do not connect, save, sync, or run health checks yet.</p>
      <div className="integration-grid">
        {integrationPlaceholders.map((integration) => (
          <Panel key={integration.name} title={integration.name} icon={<Radar size={18} />}>
            <div className="integration-placeholder-copy">
              <p>{integration.description}</p>
              <span className="pill pill-info">Coming soon</span>
            </div>
            <fieldset className="form-grid integration-placeholder-fields" disabled aria-disabled="true">
              <label>
                Enabled
                <input type="checkbox" checked={false} readOnly />
              </label>
              <label>
                Base URL
                <input value="" readOnly placeholder={integration.urlPlaceholder} />
              </label>
              <label>
                API key
                <input value="" readOnly placeholder={integration.keyPlaceholder} />
              </label>
            </fieldset>
          </Panel>
        ))}
      </div>
      <button type="button" disabled>
        <CheckCircle2 size={16} />
        Save integrations unavailable
      </button>
    </>
  );
}

export function SettingsPage({ activeView }: { activeView: SettingsView }) {
  const queryClient = useQueryClient();
  const paths = useQuery({ queryKey: ["paths"], queryFn: api.getPaths, enabled: activeView === "library" });
  const sections = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections, enabled: activeView === "library" });
  const [sectionsDraft, setSectionsDraft] = useState<SectionDraft[]>([createEmptySectionDraft("section-new-0")]);
  useEffect(() => {
    if (sections.data) setSectionsDraft(sectionSettingsToDrafts(sections.data));
  }, [sections.data]);
  const saveSections = useMutation({
    mutationFn: () => api.saveSections(sectionDraftsToSettings(sectionsDraft)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["section-settings"] });
      queryClient.invalidateQueries({ queryKey: ["sections"] });
      queryClient.invalidateQueries({ queryKey: ["scan-settings"] });
      queryClient.invalidateQueries({ queryKey: ["audit-settings"] });
    }
  });
  const sectionSettingsDraft = sectionDraftsToSettings(sectionsDraft);
  const canSaveSections = sectionSettingsDraft.sections.length > 0 && !saveSections.isPending;
  const addSectionDraft = () => {
    setSectionsDraft((drafts) => [...drafts, createEmptySectionDraft(`section-new-${Date.now()}`)]);
  };
  const subtitle =
    activeView === "library"
      ? "Name storage locations, review mounted paths, and manage library sections."
      : activeView === "integrations"
        ? "Preview planned external connection settings."
      : activeView === "advanced"
        ? "Tune job behavior and verification defaults."
        : "Manage display preferences and account access.";
  const activeTitle = activeView === "library" ? "Library" : activeView === "integrations" ? "Integrations" : activeView === "advanced" ? "Advanced" : "User settings";
  return (
    <Page title={`Settings > ${activeTitle}`} subtitle={subtitle}>
      {activeView === "library" ? (
        <>
          <StorageLocationsPanel paths={paths.data ?? { symlinkDir: "", localDir: "", remoteDir: "" }} isLoadingPaths={paths.isLoading} pathsError={paths.error?.message} />
          <Panel title="Sections" icon={<ServerCog size={18} />}>
            <div className="section-settings">
              <p className="section-settings-help">Symlink folder is the exact folder name inside the symlink directory. Type controls movie/show counting, and Library title is the display name shown in Library.</p>
              <SectionDraftList drafts={sectionsDraft} onChange={setSectionsDraft} />
              <div className="section-settings-actions">
                <button className="secondary" type="button" onClick={addSectionDraft}>
                  <Plus size={16} />
                  Add section
                </button>
                <button type="button" onClick={() => saveSections.mutate()} disabled={!canSaveSections}>
                  <CheckCircle2 size={16} />
                  Save sections
                </button>
              </div>
            </div>
          </Panel>
        </>
      ) : null}
      {activeView === "integrations" ? <IntegrationSettingsPanel /> : null}
      {activeView === "advanced" ? <AdvancedSettingsPanel /> : null}
      {activeView === "user" ? <UserSettingsPanel /> : null}
    </Page>
  );
}

function StorageLocationsPanel({ paths, isLoadingPaths, pathsError }: { paths: PathsSettings; isLoadingPaths: boolean; pathsError?: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["storage-locations"], queryFn: api.getStorageLocations });
  const [draftNames, setDraftNames] = useState<Record<StorageLocationKey, string>>({ location_1: "Local", location_2: "Remote" });
  const [message, setMessage] = useState<string | null>(null);
  const locations = settings.data?.locations ?? defaultStorageLocations.locations;

  useEffect(() => {
    if (!settings.data) return;
    setDraftNames(
      Object.fromEntries(settings.data.locations.map((location) => [location.key, location.displayName])) as Record<StorageLocationKey, string>
    );
  }, [settings.data]);

  const trimmedNames: Record<StorageLocationKey, string> = {
    location_1: draftNames.location_1.trim(),
    location_2: draftNames.location_2.trim()
  };
  const validationError =
    !trimmedNames.location_1 || !trimmedNames.location_2
      ? "Each location needs a friendly name."
      : trimmedNames.location_1.toLowerCase() === trimmedNames.location_2.toLowerCase()
        ? "Friendly names must be unique."
        : null;
  const hasChanges = locations.some((location) => trimmedNames[location.key] !== location.displayName);
  const save = useMutation({
    mutationFn: () =>
      api.saveStorageLocations({
        locations: locations.map((location) => ({ key: location.key, displayName: trimmedNames[location.key] }))
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["storage-locations"], data);
      setDraftNames(Object.fromEntries(data.locations.map((location) => [location.key, location.displayName])) as Record<StorageLocationKey, string>);
      setMessage("Friendly names saved.");
    }
  });

  function updateName(key: StorageLocationKey, value: string) {
    setMessage(null);
    save.reset();
    setDraftNames((current) => ({ ...current, [key]: value }));
  }

  return (
    <Panel title="Storage Locations" icon={<FolderCog size={18} />}>
      <div className="location-settings">
        <p id="locations-note" className="section-settings-help">
          Friendly names are used in the interface. Mounted paths remain managed through <code>.env</code> and Docker Compose.
        </p>
        {pathsError ? <p className="panel-message action-error">{pathsError}</p> : null}
        {settings.error ? <p className="panel-message action-error">{settings.error.message}</p> : null}
        <div className="location-symlink-path" aria-describedby="locations-note">
          <label className="location-path-field">
            Symlink directory
            <input value={isLoadingPaths ? "Loading..." : paths.symlinkDir} readOnly aria-readonly="true" />
          </label>
        </div>
        <div className="location-settings-list" aria-describedby="locations-note">
          {locations.map((location, index) => {
            const pathValue = location.path || (location.rootType === "local" ? paths.localDir : paths.remoteDir);
            return (
              <div key={location.key} className="location-settings-row">
                <div className="location-settings-identity">
                  <strong>Location {index + 1}</strong>
                  <span>{location.rootType === "local" ? "Local role" : "Remote role"}</span>
                </div>
                <label>
                  Friendly name
                  <input
                    value={draftNames[location.key]}
                    maxLength={40}
                    autoComplete="off"
                    aria-label={`Location ${index + 1} friendly name`}
                    onChange={(event) => updateName(location.key, event.target.value)}
                  />
                </label>
                <label className="location-path-field">
                  Mounted path
                  <input value={settings.isLoading || isLoadingPaths ? "Loading..." : pathValue} readOnly aria-readonly="true" aria-label={`Location ${index + 1} mounted path`} />
                </label>
              </div>
            );
          })}
        </div>
        <div className="location-settings-actions">
          <span aria-live="polite">
            {validationError ? <span className="action-error">{validationError}</span> : save.error ? <span className="action-error">{save.error.message}</span> : message}
          </span>
          <button type="button" onClick={() => save.mutate()} disabled={settings.isLoading || save.isPending || Boolean(validationError) || !hasChanges}>
            <CheckCircle2 size={16} />
            {save.isPending ? "Saving..." : "Save friendly names"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function AdvancedSettingsPanel() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["advanced-settings"], queryFn: api.getAdvancedSettings });
  const [draft, setDraft] = useState<AdvancedSettings>(defaultAdvancedSettings);
  const [message, setMessage] = useState<string | null>(null);
  const savedAdvancedSettings = normalizeAdvancedSettings(settings.data ?? defaultAdvancedSettings);
  const savedCopyProfileLabel = copyProfileOptions.find((option) => option.value === savedAdvancedSettings.copy.profile)?.label ?? savedAdvancedSettings.copy.profile;
  const savedAuditModeLabel = auditModeOptions.find((option) => option.value === savedAdvancedSettings.audit.defaultMode)?.label ?? savedAdvancedSettings.audit.defaultMode;
  const validationError = draft.copy.profile === "custom" && !draft.copy.byteCompare && draft.copy.mediaValidation === "off"
    ? "Custom copy verification must keep byte compare or media validation enabled."
    : null;
  const save = useMutation({
    mutationFn: () => api.saveAdvancedSettings(draft),
    onSuccess: (data) => {
      const normalized = normalizeAdvancedSettings(data);
      queryClient.setQueryData(["advanced-settings"], normalized);
      setDraft(normalized);
      setMessage("Advanced settings saved.");
    }
  });
  useEffect(() => {
    if (settings.data) setDraft(normalizeAdvancedSettings(settings.data));
  }, [settings.data]);

  function setCopyProfile(profile: CopyVerificationProfile) {
    setMessage(null);
    setDraft((current) => ({
      ...current,
      copy: profile === "custom" ? { ...current.copy, profile } : copyBehaviorForProfile(profile)
    }));
  }

  function updateCustomCopy(patch: Partial<AdvancedSettings["copy"]>) {
    setMessage(null);
    setDraft((current) => ({ ...current, copy: { ...current.copy, ...patch, profile: "custom" } }));
  }

  function updateAuditDefaults(patch: Partial<AdvancedSettings["audit"]>) {
    setMessage(null);
    setDraft((current) => ({ ...current, audit: { ...current.audit, ...patch } }));
  }

  const copyVerificationDisabled = !draft.copy.byteCompare && draft.copy.mediaValidation === "off";
  const effectiveCopyPipeline = copyVerificationDisabled
    ? ["Transfer to temporary destination", "Confirm transferred file size", "Copy verification skipped", "Promote transferred file", "Repoint symlink"]
    : [
        "Transfer to temporary destination",
        ...(draft.copy.byteCompare ? ["Byte compare source and destination"] : ["Byte compare skipped"]),
        copyPipelineLabels[draft.copy.mediaValidation],
        "Promote verified file",
        "Repoint symlink"
      ];
  const isCustomCopyProfile = draft.copy.profile === "custom";
  const selectedMediaValidation = mediaValidationOptions.find((option) => option.value === draft.copy.mediaValidation);

  return (
    <div className="advanced-settings">
      {settings.error ? <p className="panel-message action-error">{settings.error.message}</p> : null}
        <section className="advanced-settings-section">
          <div className="advanced-settings-heading">
            <div>
              <h3>Copy verification</h3>
              <p>Controls the verification work after each transfer before a symlink is repointed.</p>
            </div>
            <span className="pill pill-info">Current: {savedCopyProfileLabel}</span>
          </div>
          <div className="advanced-option-grid">
            {copyProfileOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`advanced-option${draft.copy.profile === option.value ? " selected" : ""}`}
                onClick={() => setCopyProfile(option.value)}
              >
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
          <div className="advanced-settings-grid">
            <label className="advanced-toggle">
              <input
                type="checkbox"
                checked={draft.copy.byteCompare}
                disabled={!isCustomCopyProfile}
                onChange={(event) => updateCustomCopy({ byteCompare: event.target.checked })}
              />
              <span>
                <strong>Byte compare</strong>
                <small>Compare source and destination bytes.</small>
              </span>
            </label>
            {isCustomCopyProfile ? (
              <label className="advanced-field">
                <span>Media validation</span>
                <select value={draft.copy.mediaValidation} onChange={(event) => updateCustomCopy({ mediaValidation: event.target.value as CopyMediaValidationMode })}>
                  {mediaValidationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} - {option.detail}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="advanced-field" aria-label="Media validation">
                <span>Media validation</span>
                <div className="advanced-readonly-value">
                  <strong>{selectedMediaValidation?.label ?? draft.copy.mediaValidation}</strong>
                  <small>{selectedMediaValidation?.detail ?? "Current preset value"}</small>
                </div>
              </div>
            )}
          </div>
          <div className="effective-pipeline" aria-label="Effective copy pipeline">
            <div>
              <strong>Effective pipeline</strong>
            </div>
            <ol>
              {effectiveCopyPipeline.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          {validationError ? <p className="panel-message action-error">{validationError}</p> : null}
        </section>

        <section className="advanced-settings-section">
          <div className="advanced-settings-heading">
            <div>
              <h3>Audit defaults</h3>
              <p>Controls the default mode used by audit prompts and whether known source files are compared.</p>
            </div>
            <span className="pill pill-info">Current: {savedAuditModeLabel}</span>
          </div>
          <div className="advanced-option-grid two-columns">
            {auditModeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`advanced-option${draft.audit.defaultMode === option.value ? " selected" : ""}`}
                onClick={() => updateAuditDefaults({ defaultMode: option.value })}
              >
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
          <div className="advanced-settings-grid">
            <label className="advanced-toggle">
              <input
                type="checkbox"
                checked={draft.audit.byteCompareWhenSourceKnown}
                onChange={(event) => updateAuditDefaults({ byteCompareWhenSourceKnown: event.target.checked })}
              />
              <span>
                <strong>Byte compare when source is known</strong>
                <small>Skip this when media validation alone is enough.</small>
              </span>
            </label>
          </div>
        </section>

        <div className="advanced-settings-actions">
          {message ? <span className="success">{message}</span> : null}
          {save.error ? <span className="error">{save.error.message}</span> : null}
          <button type="button" onClick={() => save.mutate()} disabled={Boolean(validationError) || save.isPending || settings.isLoading}>
            <CheckCircle2 size={16} />
            Save advanced settings
          </button>
        </div>
      </div>
  );
}

function UserSettingsPanel() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const userPreferences = useQuery({ queryKey: ["user-preferences"], queryFn: api.getUserPreferences });
  const currentPreferences: UserPreferences = { ...defaultUserPreferences, ...userPreferences.data };
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [displayMessage, setDisplayMessage] = useState<string | null>(null);
  const saveUser = useMutation({
    mutationFn: api.updateUser,
    onSuccess: (data) => {
      queryClient.setQueryData(["me"], { authenticated: true, setupRequired: false, user: data.user });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setFormError(null);
      setAccountMessage("Account settings saved.");
    }
  });
  const saveDisplayPreferences = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (preferences) => {
      queryClient.setQueryData(["user-preferences"], preferences);
      setDisplayMessage("Display settings saved.");
    }
  });

  useEffect(() => {
    if (me.data?.user?.username) setUsername(me.data.user.username);
  }, [me.data?.user?.username]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccountMessage(null);
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setFormError("Username is required.");
      return;
    }
    if (!currentPassword) {
      setFormError("Current password is required.");
      return;
    }
    if ((newPassword || confirmNewPassword) && newPassword !== confirmNewPassword) {
      setFormError("Passwords do not match.");
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setFormError(null);
    saveUser.mutate({
      username: trimmedUsername,
      currentPassword,
      newPassword: newPassword || undefined,
      confirmNewPassword: confirmNewPassword || undefined
    });
  }

  const currentTimeFormat = currentPreferences.timeFormat;
  const currentAutoOpenTaskStatus = currentPreferences.autoOpenTaskStatus;
  const error = formError ?? saveUser.error?.message;
  const displayPreferenceError = userPreferences.error?.message ?? saveDisplayPreferences.error?.message;

  return (
    <>
      <Panel title="Interface preferences" icon={<Settings size={18} />}>
        <div className="display-preferences">
          <div className="preference-row">
            <div className="preference-copy">
              <strong>Time format</strong>
              <small>Controls dates and history timestamps.</small>
            </div>
            <div className="segmented compact" role="group" aria-label="Time format">
              {timeFormatOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={currentTimeFormat === option.value ? "selected" : ""}
                  aria-pressed={currentTimeFormat === option.value}
                  disabled={userPreferences.isLoading || saveDisplayPreferences.isPending}
                  onClick={() => {
                    setDisplayMessage(null);
                    saveDisplayPreferences.mutate({ ...currentPreferences, timeFormat: option.value });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="preference-toggle">
            <input
              type="checkbox"
              checked={currentAutoOpenTaskStatus}
              disabled={userPreferences.isLoading || saveDisplayPreferences.isPending}
              onChange={(event) => {
                setDisplayMessage(null);
                saveDisplayPreferences.mutate({ ...currentPreferences, autoOpenTaskStatus: event.currentTarget.checked });
              }}
            />
            <span>
              <strong>Open task status automatically</strong>
              <small>Show the live status window after starting scans, audits, or copies. Jobs stay available from Recent Jobs either way.</small>
            </span>
          </label>
          {displayMessage ? <p className="success">{displayMessage}</p> : null}
          {displayPreferenceError ? <p className="error">{displayPreferenceError}</p> : null}
        </div>
      </Panel>
      <Panel title="Account access" icon={<UserCog size={18} />}>
        <form className="account-settings-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              Username
              <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              Current password
              <input autoComplete="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </label>
            <label>
              New password
              <input autoComplete="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            <label>
              Confirm new password
              <input autoComplete="new-password" type="password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={saveUser.isPending || me.isLoading}>
              <CheckCircle2 size={16} />
              Save account changes
            </button>
            {accountMessage ? <p className="success">{accountMessage}</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </div>
        </form>
      </Panel>
    </>
  );
}

export function LogsPage() {
  const { timeFormat } = useUserPreferences();
  const { job: linkedJobId } = logsRouteApi.useSearch();
  const jobs = useQuery({ queryKey: ["jobs", "log"], queryFn: () => api.jobs(), refetchInterval: 3000 });
  const linkedJob = useQuery({ queryKey: ["job", linkedJobId], queryFn: () => api.job(linkedJobId!), enabled: Boolean(linkedJobId) });
  const sections = useQuery({ queryKey: ["sections"], queryFn: api.sections, staleTime: 30_000 });
  const [selectedJob, setSelectedJob] = useState<number | null>(linkedJobId ?? null);
  const [jobSearch, setJobSearch] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>("all");
  const [levelFilter, setLevelFilter] = useState<EventLevelFilter>("all");
  const jobRows = useMemo(() => {
    const rows = jobs.data ?? [];
    if (!linkedJob.data || rows.some((job) => job.id === linkedJob.data.id)) return rows;
    return [linkedJob.data, ...rows];
  }, [jobs.data, linkedJob.data]);
  const sectionRows = useMemo(() => (sections.data ?? []).map((section) => ({ section: section.section, title: section.title })), [sections.data]);

  useEffect(() => {
    if (linkedJobId) setSelectedJob(linkedJobId);
  }, [linkedJobId]);

  const filteredJobs = useMemo(
    () => jobRows.filter((job) => matchesJobFilters(job, { search: jobSearch, status: statusFilter, type: typeFilter })),
    [jobRows, jobSearch, statusFilter, typeFilter]
  );
  const effectiveJob =
    filteredJobs.find((job) => job.id === selectedJob) ??
    filteredJobs.find((job) => job.status === "running") ??
    filteredJobs.find((job) => job.status === "partially_failed") ??
    filteredJobs.find((job) => job.status === "failed") ??
    filteredJobs[0] ??
    null;
  const selectedJobActive = effectiveJob?.status === "queued" || effectiveJob?.status === "running";
  const events = useJobEventTimeline({ jobId: effectiveJob?.id, enabled: Boolean(effectiveJob), refetchInterval: selectedJobActive ? 500 : false });
  const eventRows = events.events;
  const filteredEvents = useMemo(
    () => eventRows.filter((event) => matchesEventFilters(event, { search: eventSearch, level: levelFilter })),
    [eventRows, eventSearch, levelFilter]
  );

  return (
    <Page title="Logs" subtitle="Job activity, warnings, errors, and details.">
      <div className="logs-summary">
        <LogSummaryCard label="Jobs" value={jobRows.length} />
        <LogSummaryCard label="Running" value={countJobsByStatus(jobRows, "running")} />
        <LogSummaryCard
          label="Partially failed"
          value={countJobsByStatus(jobRows, "partially_failed")}
          tone={countJobsByStatus(jobRows, "partially_failed") > 0 ? "bad" : undefined}
        />
        <LogSummaryCard label="Failed" value={countJobsByStatus(jobRows, "failed")} tone={countJobsByStatus(jobRows, "failed") > 0 ? "bad" : undefined} />
        <LogSummaryCard label="Completed" value={countJobsByStatus(jobRows, "completed")} />
      </div>
      <div className="logs-layout">
        <Panel title="Jobs" icon={<Activity size={18} />}>
          <div className="log-toolbar">
            <label className="log-search">
              <span>Search jobs</span>
              <span className="search-input">
                <Search size={15} />
                <input value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} placeholder="ID, type, folder" />
              </span>
            </label>
            <LogFilterGroup
              label="Status"
              options={logStatusFilters.map((filter) => ({
                ...filter,
                count: filter.value === "all" ? jobRows.length : countJobsByStatus(jobRows, filter.value)
              }))}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <LogFilterGroup
              label="Type"
              options={logTypeFilters.map((filter) => ({
                ...filter,
                count: filter.value === "all" ? jobRows.length : countJobsByType(jobRows, filter.value)
              }))}
              value={typeFilter}
              onChange={setTypeFilter}
            />
          </div>
          {jobs.isLoading ? <p className="panel-message">Loading jobs...</p> : null}
          {jobs.error ? <p className="panel-message action-error">{jobs.error.message}</p> : null}
          {linkedJob.error ? <p className="panel-message action-error">{linkedJob.error.message}</p> : null}
          {!jobs.isLoading && !jobs.error && filteredJobs.length === 0 ? <p className="panel-message">No jobs match the current filters.</p> : null}
          {filteredJobs.length > 0 ? (
            <div className="log-job-list">
              {filteredJobs.map((job) => (
                <LogJobButton key={job.id} job={job} selected={effectiveJob?.id === job.id} sections={sectionRows} timeFormat={timeFormat} onSelect={() => setSelectedJob(job.id)} />
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel title={effectiveJob ? `Job #${effectiveJob.id} events` : "Events"} icon={<FileText size={18} />}>
          {effectiveJob ? <SelectedLogJobSummary job={effectiveJob} sections={sectionRows} timeFormat={timeFormat} /> : <p className="panel-message">No job selected.</p>}
          {effectiveJob ? (
            <div className="log-toolbar event-toolbar">
              <label className="log-search">
                <span>Search events</span>
                <span className="search-input">
                  <Search size={15} />
                  <input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} placeholder="Message or path" />
                </span>
              </label>
              <LogFilterGroup
                label="Level"
                options={logLevelFilters.map((filter) => ({
                  ...filter,
                  count: filter.value === "all" ? eventRows.length : countEventsByLevel(eventRows, filter.value)
                }))}
                value={levelFilter}
                onChange={setLevelFilter}
              />
            </div>
          ) : null}
          {effectiveJob ? (
            <div className="log-event-pagination">
              <span>{events.isLoading ? "Loading events..." : jobEventCountLabel(eventRows.length, events.total)}</span>
              {events.hasNextPage ? (
                <button type="button" className="secondary" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                  <ArrowUp size={14} />
                  {events.isFetchingNextPage ? "Loading older events..." : "Load older events"}
                </button>
              ) : null}
            </div>
          ) : null}
          {events.isLoading ? <p className="panel-message">Loading events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {effectiveJob && !events.isLoading && !events.error && filteredEvents.length === 0 ? <p className="panel-message">No events match the current filters.</p> : null}
          {filteredEvents.length > 0 ? (
            <div className="events">
              {filteredEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={effectiveJob} />
              ))}
            </div>
          ) : null}
        </Panel>
      </div>
    </Page>
  );
}

const logStatusFilters: Array<{ value: JobStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "partially_failed", label: "Partially failed" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Done" },
  { value: "queued", label: "Queued" },
  { value: "cancelled", label: "Cancelled" }
];

const logTypeFilters: Array<{ value: JobTypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "scan", label: "Scans" },
  { value: "audit", label: "Audits" },
  { value: "copy", label: "Copies" },
  { value: "path_migration", label: "Path migrations" },
];

const logLevelFilters: Array<{ value: EventLevelFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings" },
  { value: "info", label: "Info" }
];

function LogSummaryCard({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className={`log-summary-card${tone ? ` log-summary-card-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function LogFilterGroup<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: Array<{ value: T; label: string; count: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="log-filter-group" aria-label={`${label} filter`}>
      <span>{label}</span>
      <div className="segmented compact">
        {options.map((option) => (
          <button key={option.value} type="button" className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>
            {option.label}
            <small>{formatNumber(option.count)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function LogJobButton({
  job,
  selected,
  sections,
  timeFormat,
  onSelect
}: {
  job: JobRecord;
  selected: boolean;
  sections: Array<{ section: string; title?: string | null }>;
  timeFormat: TimeFormatPreference;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`log-job-card${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className="log-job-card-main">
        <span>
          <strong>#{job.id}</strong>
          <span>{formatJobType(job.type)}</span>
        </span>
        <StatusPill value={job.status} />
      </span>
      <span className="log-job-card-meta">
        <span>{formatDate(job.startedAt ?? job.createdAt, timeFormat)}</span>
        <span>{jobDurationLabel(job)}</span>
      </span>
      <JobScope job={job} sections={sections} />
      <LogChipList chips={jobProgressChips(job, 4)} />
    </button>
  );
}

function SelectedLogJobSummary({ job, sections, timeFormat }: { job: JobRecord; sections: Array<{ section: string; title?: string | null }>; timeFormat: TimeFormatPreference }) {
  return (
    <div className="selected-log-job">
      <div className="selected-log-job-main">
        <div>
          <strong>{formatJobType(job.type)}</strong>
          <span>#{job.id}</span>
        </div>
        <StatusPill value={job.status} />
      </div>
      <dl className="selected-log-job-details">
        <div>
          <dt>Started</dt>
          <dd>{formatDate(job.startedAt, timeFormat)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatDate(job.finishedAt, timeFormat)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{jobDurationLabel(job)}</dd>
        </div>
      </dl>
      <div className="selected-log-job-scope">
        <JobScope job={job} sections={sections} />
      </div>
      {job.type === "scan" ? <ScanProgressPanel job={job} compact /> : null}
      {job.type === "audit" ? <AuditProgressPanel job={job} compact /> : null}
      {job.type === "copy" ? <CopyProgressPanel job={job} compact /> : null}
      <LogChipList chips={jobProgressChips(job)} />
    </div>
  );
}
