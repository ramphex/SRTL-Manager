import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, CheckCircle2, ChevronRight, Copy, Database, File, FileText, Folder, HardDrive, HardDriveDownload, Library, Link2, ListChecks, RefreshCw, Search, Settings, Shield, Trash2, TriangleAlert, Unlink, X } from "lucide-react";
import { api } from "./api";
import { evaluateSourceTitleRisk, type SourceTitleRiskResult } from "../shared/sourceTitleRisk";
import { activeJobForLink, activeJobNotice, activeJobsForLinks, activeJobsForStoragePolicyTitle, isActiveQueueJob, normalizeAuditTargets } from "./jobScopeLocks";
import { inventoryPolicyNeededCount, mediaLinkTreeStatusCounts, orderSectionSummaries, sectionActionUnit, sectionCompositionParts, type LinkStatusWorkKind } from "./sectionSummaryDisplay";
import { inferSectionContentType } from "../shared/sections";
import { type AuditOptions, type AuditSettings, type InventorySummary, type JobRecord, type CopyDirection, type CopyOptions, type MediaLinkRow, type MediaLinkTree, type MediaLinkTreeNode, type ScanOptions, type ScanTitleScope, type SectionSummary, type StoragePolicyKind, type StoragePolicyTitle, type StorageFileRow, type StorageFileTree, type StorageFileTreeNode, type StorageLocationsSettings, type StorageRootType, type TimeFormatPreference } from "../shared/types";
import { InfoTooltip, Page, Panel, StatCard, StatusPill } from "./App";
import { AuditPrompt, AuditStatusPrompt, CopyPrompt, formatBytes, formatDate, formatNumber, inventoryCopyToLocalCount, inventoryCopyToRemoteCount, nonShowSectionMetricLabel, oldestScanAgeLabel, scanAgeLabel, ScanStatusPrompt, sectionContentType, sectionDisplayTitle, sectionPolicyNeededCount, storageLocationName, storagePolicyActionText, storagePolicyCategoryLabels, storagePolicyLabel, storageRootOrder, storageStatusDisplayLabel, SymlinkKindFilter, symlinkKindFilterLabels, useStartCopyJob, useStorageLocations, useUserPreferences } from "./appShared";
import { AuditDialog, AuditStatusDialog, CopyDialog, FolderScopePicker, JobsTable, ScanScopeBlock, ScanStatusDialog } from "./jobPresentation";
import { auditStatusPromptFromJob, copyPromptFromJob, copyPromptKey, formatAuditScope, formatScanScope, scanStatusPromptFromJob } from "./jobPresentationUtils";

function stripLegacyScanSections(options: ScanOptions): ScanOptions {
  const { sections: _legacySections, ...nextOptions } = options;
  return nextOptions;
}

function titleRescanOptions(titleScopes: ScanTitleScope[]): ScanOptions {
  const uniqueScopes = [...new Map(titleScopes.map((scope) => [`${scope.section}\0${scope.itemName}`, scope])).values()];
  return {
    scanSymlinks: true,
    scanLocal: false,
    scanRemote: false,
    symlinkSections: [...new Set(uniqueScopes.map((scope) => scope.section))],
    localSections: [],
    titleScopes: uniqueScopes
  };
}

function titleScopeIsPending(scopes: ScanTitleScope[] | undefined, section: string, itemName: string): boolean {
  return Boolean(scopes?.some((scope) => scope.section === section && scope.itemName === itemName));
}

function ActionToast({ message, tone }: { message: string | null; tone: "success" | "error" }) {
  const [visibleMessage, setVisibleMessage] = useState<string | null>(null);

  useEffect(() => {
    setVisibleMessage(message);
    if (!message) return;

    const timeout = window.setTimeout(() => setVisibleMessage(null), tone === "error" ? 10_000 : 6_000);
    return () => window.clearTimeout(timeout);
  }, [message, tone]);

  if (!visibleMessage || typeof document === "undefined") return null;
  const Icon = tone === "error" ? TriangleAlert : CheckCircle2;

  return createPortal(
    <div className={`action-toast action-toast-${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
      <Icon className="action-toast-icon" size={20} />
      <div className="action-toast-content">
        <strong>{tone === "error" ? "Action failed" : "Task queued"}</strong>
        <span>{visibleMessage}</span>
      </div>
      <button type="button" className="action-toast-dismiss" aria-label="Dismiss notification" onClick={() => setVisibleMessage(null)}>
        <X size={16} />
      </button>
    </div>,
    document.body
  );
}

export function DashboardPage() {
  const queryClient = useQueryClient();
  const { autoOpenTaskStatus, recentJobsCompletedWindowMinutes } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [scanOptions, setScanOptions] = useState<ScanOptions>({ scanSymlinks: true, scanLocal: false, scanRemote: false });
  const [auditSettingsDraft, setAuditSettingsDraft] = useState<AuditSettings>({ sections: [], targets: ["local", "remote"] });
  const [selectedRemoteWork, setSelectedRemoteWork] = useState<SectionWorkSelection | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  const [auditStatusPrompt, setAuditStatusPrompt] = useState<AuditStatusPrompt | null>(null);
  const [copyPrompt, setCopyPrompt] = useState<CopyPrompt | null>(null);
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const sectionSummaries = useQuery({ queryKey: ["sections"], queryFn: api.sections, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const paths = useQuery({ queryKey: ["paths"], queryFn: api.getPaths });
  const scanSettings = useQuery({ queryKey: ["scan-settings"], queryFn: api.getScanSettings });
  const auditSettings = useQuery({ queryKey: ["audit-settings"], queryFn: api.getAuditSettings });
  const inventory = useQuery({ queryKey: ["inventory-summary"], queryFn: api.inventorySummary, refetchInterval: 5000 });
  const scanTimestamps = useQuery({ queryKey: ["inventory-scan-timestamps"], queryFn: api.inventoryScanTimestamps, refetchInterval: 60000 });
  const jobs = useQuery({
    queryKey: ["jobs", "recent", recentJobsCompletedWindowMinutes],
    queryFn: () => api.jobs({ completedWithinMinutes: recentJobsCompletedWindowMinutes }),
    refetchInterval: 3000
  });
  const saveScanSettings = useMutation({
    mutationFn: api.saveScanSettings,
    onSuccess: (settings) => queryClient.setQueryData(["scan-settings"], settings)
  });
  const saveAuditSettings = useMutation({
    mutationFn: api.saveAuditSettings,
    onSuccess: (settings) => queryClient.setQueryData(["audit-settings"], settings)
  });
  const startCopySilently = useStartCopyJob();
  const copyConflictCheck = useMutation({
    mutationFn: (prompt: CopyPrompt) => {
      if (!prompt.options) throw new Error("Copy options are missing");
      return api.copyConflicts(prompt.options);
    },
    onSuccess: (conflicts, prompt) => {
      if (conflicts.totalConflicts > 0) {
        setCopyPrompt({ ...prompt, conflicts });
        return;
      }
      if (!autoOpenTaskStatus && prompt.autoStart) {
        startCopySilently.mutate(prompt);
        return;
      }
      setCopyPrompt(prompt);
    }
  });
  const startScan = useMutation({
    mutationFn: (options: ScanOptions) => api.startScan(options),
    onSuccess: async (result, submittedOptions) => {
      queryClient.invalidateQueries({ queryKey: ["scans"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-scan-timestamps"] });
      queryClient.invalidateQueries({ queryKey: ["media-links"] });
      queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
      queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
      queryClient.invalidateQueries({ queryKey: ["storage-files"] });
      await queryClient.refetchQueries({ queryKey: ["jobs"] });
      if (autoOpenTaskStatus) {
        setScanStatusPrompt({
          key: `scan-job-${result.jobId}`,
          title: "Inventory scan",
          description: formatScanScope(submittedOptions, availableScanSections),
          jobId: result.jobId
        });
      }
    }
  });
  const configuredSectionNames = sectionSettings.data?.sections ?? sectionSummaries.data?.map((section) => section.section) ?? [];
  const availableScanSections = configuredSectionNames.map((section) => ({
    section,
    title: sectionSettings.data?.sectionTitles?.[section] ?? sectionSummaries.data?.find((summary) => summary.section === section)?.title ?? section
  }));
  const availableScanSectionNames = availableScanSections.map((section) => section.section);
  const selectedSymlinkSections = (scanOptions.symlinkSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedLocalSections = (scanOptions.localSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedSymlinkScanAge =
    selectedSymlinkSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedSymlinkSections.map((section) => scanTimestamps.data?.symlinkSections[section] ?? null));
  const selectedLocalScanAge =
    selectedLocalSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedLocalSections.map((section) => scanTimestamps.data?.localSections[section] ?? null));
  const remoteScanAge = scanAgeLabel(scanTimestamps.data?.remoteRoot ?? null);
  const selectedAuditSections = auditSettingsDraft.sections.filter((section) => availableScanSectionNames.includes(section));
  const selectedAuditTargets = normalizeAuditTargets(auditSettingsDraft.targets);
  const auditLocalSelected = selectedAuditTargets.includes("local");
  const auditRemoteSelected = selectedAuditTargets.includes("remote");
  const selectedInventoryScopeCount = [scanOptions.scanSymlinks, scanOptions.scanLocal, scanOptions.scanRemote].filter(Boolean).length;
  const selectedInventoryFolderCount = selectedSymlinkSections.length + selectedLocalSections.length;
  const totalInventoryFolderCount = availableScanSectionNames.length * 2;
  const selectedAuditScopeCount = selectedAuditTargets.length;
  const allInventorySelected =
    scanOptions.scanSymlinks &&
    scanOptions.scanLocal &&
    scanOptions.scanRemote &&
    selectedSymlinkSections.length === availableScanSectionNames.length &&
    selectedLocalSections.length === availableScanSectionNames.length;
  const noInventorySelected = selectedInventoryScopeCount === 0 && selectedInventoryFolderCount === 0;
  const hasScanScope = scanOptions.scanSymlinks || scanOptions.scanLocal || scanOptions.scanRemote;
  const canRunScan =
    hasScanScope &&
    (!scanOptions.scanSymlinks || selectedSymlinkSections.length > 0) &&
    (!scanOptions.scanLocal || selectedLocalSections.length > 0) &&
    (!scanOptions.scanRemote || Boolean(paths.data?.remoteDir));
  const canRunAudit = auditRemoteSelected || (auditLocalSelected && selectedAuditSections.length > 0);
  const sectionTotals = (sectionSummaries.data ?? []).reduce(
    (acc, section) => ({
      totalLinks: acc.totalLinks + section.totalLinks,
      remoteLinks: acc.remoteLinks + section.remoteLinks,
      localLinks: acc.localLinks + section.localLinks,
      actionableRemoteLinks: acc.actionableRemoteLinks + section.actionableRemoteLinks,
      actionableLocalLinks: acc.actionableLocalLinks + section.actionableLocalLinks,
      assignedRemoteLinks: acc.assignedRemoteLinks + section.assignedRemoteLinks,
      unassignedRemoteLinks: acc.unassignedRemoteLinks + section.unassignedRemoteLinks,
      unassignedLocalLinks: acc.unassignedLocalLinks + section.unassignedLocalLinks,
      brokenLinks: acc.brokenLinks + section.brokenLinks
    }),
    {
      totalLinks: 0,
      remoteLinks: 0,
      localLinks: 0,
      actionableRemoteLinks: 0,
      actionableLocalLinks: 0,
      assignedRemoteLinks: 0,
      unassignedRemoteLinks: 0,
      unassignedLocalLinks: 0,
      brokenLinks: 0
    }
  );
  const totals = inventory.data ?? {
    ...sectionTotals,
    otherLinks: 0,
    nonMediaLinks: 0,
    localFiles: 0,
    remoteFiles: 0,
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: 0,
    unassignedLocalFiles: 0,
    localOrphanFiles: 0,
    remoteOrphanFiles: 0,
    missingLinks: 0,
    missingLocalFiles: 0,
    missingRemoteFiles: 0
  };
  const orderedSectionSummaries = orderSectionSummaries(sectionSummaries.data ?? [], sectionSettings.data?.sections);
  const totalDestinationSymlinks = totals.localLinks + totals.remoteLinks;
  const totalStorageFiles = totals.localFiles + totals.remoteFiles;
  const totalOrphanFiles = totals.localOrphanFiles + totals.remoteOrphanFiles;
  const policyNeededTotal = inventoryPolicyNeededCount(totals);
  const copyToLocalTotal = inventoryCopyToLocalCount(totals);
  const copyToRemoteTotal = inventoryCopyToRemoteCount(totals);
  const actionError =
    startScan.error ?? copyConflictCheck.error ?? startCopySilently.error ?? paths.error ?? sectionSettings.error ?? scanSettings.error ?? auditSettings.error ?? saveScanSettings.error ?? saveAuditSettings.error;
  const actionMessage = startCopySilently.data
    ? `Copy job #${startCopySilently.data.jobId} queued. View progress from Recent Jobs.`
    : startScan.data
      ? `Inventory scan job #${startScan.data.jobId} queued.`
      : null;
  const actionToastMessage = actionError?.message ?? actionMessage;

  useEffect(() => {
    if (scanSettings.data) setScanOptions(stripLegacyScanSections(scanSettings.data));
  }, [scanSettings.data]);

  useEffect(() => {
    if (auditSettings.data) setAuditSettingsDraft(auditSettings.data);
  }, [auditSettings.data]);

  function updateScanOptions(nextOptions: ScanOptions) {
    const normalizedOptions = stripLegacyScanSections(nextOptions);
    setScanOptions(normalizedOptions);
    saveScanSettings.mutate(normalizedOptions);
  }

  function updateAuditSettings(nextSettings: AuditSettings) {
    setAuditSettingsDraft(nextSettings);
    saveAuditSettings.mutate(nextSettings);
  }

  function toggleScanSection(scope: "symlinkSections" | "localSections", section: string, checked: boolean) {
    const currentSections = scanOptions[scope] ?? scanOptions.sections ?? availableScanSectionNames;
    const nextSectionSet = new Set(checked ? [...currentSections, section] : currentSections.filter((currentSection) => currentSection !== section));
    setScanSections(scope, availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)));
  }

  function setScanSections(scope: "symlinkSections" | "localSections", sections: string[]) {
    const nextSectionSet = new Set(sections);
    updateScanOptions({ ...scanOptions, [scope]: availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)) });
  }

  function selectAllInventoryScanOptions() {
    updateScanOptions({
      ...scanOptions,
      scanSymlinks: true,
      scanLocal: true,
      scanRemote: true,
      symlinkSections: availableScanSectionNames,
      localSections: availableScanSectionNames
    });
  }

  function clearAllInventoryScanOptions() {
    updateScanOptions({
      ...scanOptions,
      scanSymlinks: false,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: [],
      localSections: []
    });
  }

  function toggleAuditSection(section: string, checked: boolean) {
    const currentSections = auditSettingsDraft.sections;
    const nextSectionSet = new Set(checked ? [...currentSections, section] : currentSections.filter((currentSection) => currentSection !== section));
    updateAuditSettings({ ...auditSettingsDraft, sections: availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)) });
  }

  function toggleAuditTarget(target: StorageRootType, checked: boolean) {
    const currentTargets = selectedAuditTargets;
    const nextTargetSet = new Set(checked ? [...currentTargets, target] : currentTargets.filter((currentTarget) => currentTarget !== target));
    updateAuditSettings({ ...auditSettingsDraft, targets: storageRootOrder.filter((currentTarget) => nextTargetSet.has(currentTarget)) });
  }

  function openDashboardAuditPrompt() {
    if (!canRunAudit) return;
    const options: Omit<AuditOptions, "mode"> = {
      targets: selectedAuditTargets,
      ...(auditLocalSelected ? { sections: selectedAuditSections } : {})
    };
    setAuditPrompt({
      title: "Audit selected targets",
      description: formatAuditScope(options, availableScanSections),
      options
    });
  }

  function runInventoryScan() {
    startCopySilently.reset();
    startScan.mutate(stripLegacyScanSections(scanOptions));
  }

  function handleCopyRequest(prompt: CopyPrompt) {
    startScan.reset();
    if (prompt.options?.direction === "to_local" && !prompt.options.localConflictStrategy) {
      copyConflictCheck.mutate(prompt);
      return;
    }
    if (!autoOpenTaskStatus && prompt.autoStart) {
      startCopySilently.mutate(prompt);
      return;
    }
    setCopyPrompt(prompt);
  }

  return (
    <Page title="Dashboard" subtitle="Manual read-only inventory of symlinks, storage files, and orphans." hideHeader>
      <div className="dashboard-actions">
        <section className="action-group action-group-primary" aria-labelledby="inventory-actions-title">
          <div className="action-group-header">
            <RefreshCw size={17} />
            <h2 id="inventory-actions-title">Inventory Scan</h2>
            <InfoTooltip label="About inventory scans">
              Reads the selected symlink folders and optional storage folders, then updates SRTL Manager's inventory database without changing media files.
            </InfoTooltip>
          </div>
          <div className="inventory-scope-toolbar">
            <span>
              {selectedInventoryScopeCount}/3 categories - {selectedInventoryFolderCount}/{totalInventoryFolderCount} folders
            </span>
            <div className="inventory-scope-actions">
              <button type="button" className="secondary inventory-scope-action" onClick={selectAllInventoryScanOptions} disabled={allInventorySelected}>
                Select all
              </button>
              <button type="button" className="secondary inventory-scope-action" onClick={clearAllInventoryScanOptions} disabled={noInventorySelected}>
                Clear all
              </button>
            </div>
          </div>
          <div className="inventory-scope-list" role="group" aria-label="Inventory scan scopes">
            <ScanScopeBlock
              checked={scanOptions.scanSymlinks}
              icon={<Link2 size={15} />}
              title="Symlinks"
              detail={`${selectedSymlinkSections.length}/${availableScanSections.length} folders - ${selectedSymlinkScanAge}`}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanSymlinks: checked })}
            >
              <FolderScopePicker
                ariaLabel="Symlink folders"
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.symlinkSections ?? {}}
                selectedSections={selectedSymlinkSections}
                onToggle={(section, checked) => toggleScanSection("symlinkSections", section, checked)}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={scanOptions.scanLocal}
              icon={<HardDrive size={15} />}
              title={`${localName} files`}
              detail={`${selectedLocalSections.length}/${availableScanSections.length} folders - ${selectedLocalScanAge}`}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanLocal: checked })}
            >
              <FolderScopePicker
                ariaLabel={`${localName} file folders`}
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.localSections ?? {}}
                selectedSections={selectedLocalSections}
                onToggle={(section, checked) => toggleScanSection("localSections", section, checked)}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={scanOptions.scanRemote}
              icon={<HardDriveDownload size={15} />}
              title={`${remoteName} files`}
              detail={remoteScanAge}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanRemote: checked })}
            />
          </div>
          <button className="run-scan-button" onClick={runInventoryScan} disabled={startScan.isPending || !canRunScan}>
            <RefreshCw size={16} />
            Run Inventory Scan
          </button>
        </section>
        <section className="action-group action-group-audits" aria-labelledby="audit-actions-title">
          <div className="action-group-header">
            <Activity size={17} />
            <h2 id="audit-actions-title">Audits</h2>
            <InfoTooltip label="About audits">
              Verifies media in the selected storage locations as a read-only job. Fast audit checks container reads; deep audit fully decodes for heavier validation.
            </InfoTooltip>
          </div>
          <div className="inventory-scope-toolbar">
            <span>
              {selectedAuditScopeCount}/2 categories - {selectedAuditSections.length}/{availableScanSections.length} {localName} folders
            </span>
            <div className="inventory-scope-actions">
              <button type="button" className="secondary inventory-scope-action" onClick={() => {
                updateAuditSettings({ ...auditSettingsDraft, targets: ["local", "remote"], sections: availableScanSectionNames });
              }} disabled={auditLocalSelected && auditRemoteSelected && selectedAuditSections.length === availableScanSections.length}>
                Select all
              </button>
              <button type="button" className="secondary inventory-scope-action" onClick={() => {
                updateAuditSettings({ ...auditSettingsDraft, targets: [], sections: [] });
              }} disabled={selectedAuditScopeCount === 0 && selectedAuditSections.length === 0}>
                Clear all
              </button>
            </div>
          </div>
          <div className="inventory-scope-list" role="group" aria-label="Audit targets">
            <ScanScopeBlock
              checked={auditLocalSelected}
              icon={<HardDrive size={15} />}
              title={`${localName} targets`}
              detail={`${selectedAuditSections.length}/${availableScanSections.length} folders`}
              onChange={(checked) => toggleAuditTarget("local", checked)}
            >
              <FolderScopePicker
                ariaLabel={`${localName} audit folders`}
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.symlinkSections ?? {}}
                selectedSections={selectedAuditSections}
                onToggle={toggleAuditSection}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={auditRemoteSelected}
              icon={<HardDriveDownload size={15} />}
              title={`${remoteName} targets`}
              detail={`${remoteName} root`}
              onChange={(checked) => toggleAuditTarget("remote", checked)}
            />
          </div>
          <button className="run-scan-button" onClick={openDashboardAuditPrompt} disabled={!canRunAudit}>
            <Activity size={16} />
            Run Audit
          </button>
        </section>
      </div>
      <ActionToast message={actionToastMessage} tone={actionError ? "error" : "success"} />
      <div className="dashboard-summary">
        <section className="summary-group summary-group-attention" aria-labelledby="attention-summary-title">
          <div className="summary-group-title">
            <TriangleAlert size={15} />
            <h2 id="attention-summary-title">Needs Attention</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Unassigned" value={formatNumber(policyNeededTotal)} detail={`${localName} + ${remoteName} media`} tone={policyNeededTotal > 0 ? "warn" : "neutral"} />
            <StatCard label={`Copy to ${localName}`} value={formatNumber(copyToLocalTotal)} detail={`${remoteName} media`} tone={copyToLocalTotal > 0 ? "bad" : "neutral"} />
            <StatCard label={`Copy to ${remoteName}`} value={formatNumber(copyToRemoteTotal)} detail={`${localName} media`} tone={copyToRemoteTotal > 0 ? "bad" : "neutral"} />
            <StatCard label="Broken symlinks" value={formatNumber(totals.brokenLinks)} tone={totals.brokenLinks > 0 ? "bad" : "neutral"} />
          </div>
        </section>
        <section className="summary-group summary-group-separated" aria-labelledby="local-summary-title">
          <div className="summary-group-title">
            <HardDrive size={15} />
            <h2 id="local-summary-title">{localName}</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totals.localLinks)} />
            <StatCard label="Files" value={formatNumber(totals.localFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totals.localOrphanFiles)} />
          </div>
        </section>
        <section className="summary-group summary-group-separated" aria-labelledby="remote-summary-title">
          <div className="summary-group-title">
            <HardDriveDownload size={15} />
            <h2 id="remote-summary-title">{remoteName}</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totals.remoteLinks)} />
            <StatCard label="Files" value={formatNumber(totals.remoteFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totals.remoteOrphanFiles)} />
          </div>
        </section>
        <section className="summary-group summary-group-separated summary-group-totals" aria-labelledby="totals-summary-title">
          <div className="summary-group-title">
            <Database size={15} />
            <h2 id="totals-summary-title">Totals</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totalDestinationSymlinks)} />
            <StatCard label="Files" value={formatNumber(totalStorageFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totalOrphanFiles)} />
          </div>
        </section>
      </div>
      <SectionTable sections={orderedSectionSummaries} selectedRemoteWork={selectedRemoteWork} onRemoteWorkSelect={setSelectedRemoteWork} />
      <RemoteWorkLinksTable
        selection={selectedRemoteWork}
        sections={orderedSectionSummaries}
        pendingTitleScopes={startScan.isPending ? startScan.variables?.titleScopes : undefined}
        onClose={() => setSelectedRemoteWork(null)}
        onAuditRequest={setAuditPrompt}
        onCopyRequest={handleCopyRequest}
        onRescanTitle={(section, itemName) => startScan.mutate(titleRescanOptions([{ section, itemName }]))}
      />
      <JobsTable
        jobs={jobs.data ?? []}
        sections={availableScanSections}
        onScanJobSelect={(job) => setScanStatusPrompt(scanStatusPromptFromJob(job, availableScanSections))}
        onAuditJobSelect={(job) => setAuditStatusPrompt(auditStatusPromptFromJob(job, availableScanSections))}
        onCopyJobSelect={(job) => setCopyPrompt(copyPromptFromJob(job, availableScanSections, storageLocations))}
      />
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
      <AuditStatusDialog prompt={auditStatusPrompt} onClose={() => setAuditStatusPrompt(null)} />
      <CopyDialog prompt={copyPrompt} onClose={() => setCopyPrompt(null)} />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}


type SectionWorkKind = LinkStatusWorkKind;

type SectionWorkSelection = {
  section: string;
  kind: SectionWorkKind;
  relativePathPrefix?: string;
  scopeLabel?: string;
};

function SectionTable({
  sections,
  selectedRemoteWork,
  onRemoteWorkSelect
}: {
  sections: SectionSummary[];
  selectedRemoteWork: SectionWorkSelection | null;
  onRemoteWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  return (
    <Panel title="Library Summary" icon={<Database size={18} />}>
      <table className="responsive-table library-summary-table">
        <thead>
          <tr>
            <th>Section</th>
            <th>
              <span className="summary-table-heading">
                Unassigned
                <small>{localName} + {remoteName} media</small>
              </span>
            </th>
            <th>
              <span className="summary-table-heading">
                Copy To {localName}
                <small>{remoteName} media</small>
              </span>
            </th>
            <th>
              <span className="summary-table-heading">
                Copy To {remoteName}
                <small>{localName} media</small>
              </span>
            </th>
            <th>Broken Symlinks</th>
            <th>{localName} Symlinks</th>
            <th>{remoteName} Symlinks</th>
            <th>Total Symlinks</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const title = sectionDisplayTitle(section);
            const policyNeeded = sectionPolicyNeededCount(section);
            const copyToLocal = section.actionableRemoteLinks;
            const copyToRemote = section.actionableLocalLinks;
            const policyUnit = sectionActionUnit(section, policyNeeded);
            const copyToLocalUnit = sectionActionUnit(section, copyToLocal);
            const copyToRemoteUnit = sectionActionUnit(section, copyToRemote);
            return (
              <tr key={section.section}>
                <td>
                  <span className="section-name-cell">
                    <strong>{title}</strong>
                    <small>{sectionCompositionParts(section).map(formatSectionCompositionPart).join(" / ")}</small>
                  </span>
                </td>
                <td>
                  {policyNeeded > 0 ? (
                    <button
                      type="button"
                      className={
                        selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "policy_needed"
                          ? "table-count-button table-count-button-warn selected"
                          : "table-count-button table-count-button-warn"
                      }
                      data-section-needs-assignment={section.section}
                      aria-label={`${title}: ${formatNumber(policyNeeded)} ${policyUnit} need a storage policy`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "policy_needed"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "policy_needed" })}
                    >
                      <SummaryCount value={policyNeeded} unit={policyUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={policyNeeded} unit={policyUnit} muted />
                  )}
                </td>
                <td>
                  {copyToLocal > 0 ? (
                    <button
                      type="button"
                      className={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_local" ? "table-count-button selected" : "table-count-button"}
                      data-section-copy-to-local={section.section}
                      aria-label={`${title}: ${formatNumber(copyToLocal)} ${copyToLocalUnit} need copy to ${localName}`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_local"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "copy_to_local" })}
                    >
                      <SummaryCount value={copyToLocal} unit={copyToLocalUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={copyToLocal} unit={copyToLocalUnit} muted />
                  )}
                </td>
                <td>
                  {copyToRemote > 0 ? (
                    <button
                      type="button"
                      className={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_remote" ? "table-count-button selected" : "table-count-button"}
                      data-section-copy-to-remote={section.section}
                      aria-label={`${title}: ${formatNumber(copyToRemote)} ${copyToRemoteUnit} need copy to ${remoteName}`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_remote"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "copy_to_remote" })}
                    >
                      <SummaryCount value={copyToRemote} unit={copyToRemoteUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={copyToRemote} unit={copyToRemoteUnit} muted />
                  )}
                </td>
                <td>{formatNumber(section.brokenLinks)}</td>
                <td>{formatNumber(section.localLinks)}</td>
                <td>{formatNumber(section.remoteLinks)}</td>
                <td>{formatNumber(section.totalLinks)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function SummaryCount({ value, unit, muted = false }: { value: number; unit: string; muted?: boolean }) {
  return (
    <span className={muted ? "summary-count-cell summary-count-cell-muted" : "summary-count-cell"}>
      <strong>{formatNumber(value)}</strong>
      <small>{unit}</small>
    </span>
  );
}

function formatSectionCompositionPart(part: { value: number; unit: string }): string {
  return `${formatNumber(part.value)} ${part.unit}`;
}

const dashboardRemoteWorkLinkLimit = 250;

async function loadAllRemoteWorkLinks(
  params: Omit<Parameters<typeof api.mediaLinksPage>[0], "limit" | "offset">
): Promise<Awaited<ReturnType<typeof api.mediaLinksPage>>> {
  const rows: MediaLinkRow[] = [];
  const seenIds = new Set<number>();
  let offset = 0;
  let total: number;

  while (true) {
    const page = await api.mediaLinksPage({ ...params, limit: dashboardRemoteWorkLinkLimit, offset });
    total = page.total;
    for (const row of page.rows) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      rows.push(row);
    }
    if (!page.hasMore) break;
    const nextOffset = page.offset + page.rows.length;
    if (nextOffset <= offset) throw new Error("The work list did not advance while loading additional results");
    offset = nextOffset;
  }

  return { rows, total, limit: dashboardRemoteWorkLinkLimit, offset: 0, hasMore: false };
}

type ActionableEpisode = {
  episodeName: string;
  link: MediaLinkRow;
};

type ActionableSeasonGroup = {
  seasonName: string;
  episodes: ActionableEpisode[];
};

type ActionableShowGroup = {
  showName: string;
  seasonCount: number;
  episodeCount: number;
  seasons: ActionableSeasonGroup[];
};

const actionableTitleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function uniqueMediaTitles(links: MediaLinkRow[]): string[] {
  return [...new Set(links.map((link) => link.itemName).filter(Boolean))];
}

function uniqueTitles(titles: string[]): string[] {
  return [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
}

function sourceTitleRiskForLink(link: MediaLinkRow): SourceTitleRiskResult {
  return evaluateSourceTitleRisk({ expectedTitle: link.itemName, sourcePath: link.targetPath });
}

function worstSourceTitleRisk(links: MediaLinkRow[]): SourceTitleRiskResult | null {
  const risks = links.map(sourceTitleRiskForLink);
  return risks.sort((first, second) => sourceTitleRiskRank(second.severity) - sourceTitleRiskRank(first.severity) || second.score - first.score)[0] ?? null;
}

function sourceTitleRiskRank(severity: SourceTitleRiskResult["severity"]): number {
  if (severity === "block") return 2;
  if (severity === "warn") return 1;
  return 0;
}

function riskySourceTitleCount(links: MediaLinkRow[]): number {
  return links.map(sourceTitleRiskForLink).filter((risk) => risk.severity !== "ok").length;
}

function SourceTitleRiskBadge({ risk, count }: { risk: SourceTitleRiskResult | null; count?: number }) {
  if (!risk || risk.severity === "ok") return null;
  const countLabel = count && count > 1 ? ` (${formatNumber(count)} links)` : "";
  const sourceLabel = risk.sourceParent ? `${risk.sourceParent} / ${risk.sourceName}` : risk.sourceName;

  return (
    <span className={`source-title-risk-badge ${risk.severity}`} title={`${risk.reason}${countLabel}. Expected: ${risk.expectedTitle}. Source: ${sourceLabel}.`}>
      <TriangleAlert size={13} />
      <span className="sr-only">{risk.reason}</span>
    </span>
  );
}

function BulkActionBar({
  selectedCount,
  totalCount,
  allSelected,
  onSelectAll,
  onClear,
  disabled = false,
  children
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bulk-action-bar">
      <div className="bulk-selection-summary">
        <strong>{formatNumber(selectedCount)}</strong>
        <span>selected</span>
        <small>of {formatNumber(totalCount)} visible</small>
      </div>
      <div className="bulk-selection-actions">
        <button type="button" className="secondary future-action-button" onClick={onSelectAll} disabled={disabled || totalCount === 0 || allSelected}>
          Select all
        </button>
        <button type="button" className="secondary future-action-button" onClick={onClear} disabled={disabled || selectedCount === 0}>
          Select none
        </button>
      </div>
      <div className="future-actions bulk-primary-actions">{children}</div>
    </div>
  );
}

function RemoteWorkLinksTable({
  selection,
  sections,
  pendingTitleScopes,
  onClose,
  onAuditRequest,
  onCopyRequest,
  onRescanTitle
}: {
  selection: SectionWorkSelection | null;
  sections: SectionSummary[];
  pendingTitleScopes?: ScanTitleScope[];
  onClose: () => void;
  onAuditRequest: (prompt: AuditPrompt) => void;
  onCopyRequest: (prompt: CopyPrompt) => void;
  onRescanTitle: (section: string, itemName: string) => void;
}) {
  const queryClient = useQueryClient();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const selectedSection = selection?.section ?? null;
  const selectedPrefix = selection?.relativePathPrefix ?? "";
  const detail = selection ? remoteWorkDetail(selection.kind, storageLocations) : null;
  const copyDirection = selection ? copyDirectionForWorkKind(selection.kind) : null;
  const selectedSummary = sections.find((section) => section.section === selectedSection);
  const selectedContentType = selectedSummary ? sectionContentType(selectedSummary) : selectedSection ? inferSectionContentType(selectedSection) : "other";
  const isShowSection = selectedContentType === "shows";
  const [expandedShows, setExpandedShows] = useState<Record<string, boolean>>({});
  const [selectedLinkIds, setSelectedLinkIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const trimmedSearch = search.trim();
  const remoteWorkLinks = useQuery({
    queryKey: ["dashboard-remote-work-links", selection?.kind, selectedSection, selectedPrefix, trimmedSearch],
    queryFn: () =>
      loadAllRemoteWorkLinks({
        kind: detail?.kind,
        section: selectedSection ?? "",
        storagePolicy: detail?.storagePolicy ?? "unassigned",
        relativePathPrefix: selectedPrefix,
        search: trimmedSearch
      }),
    enabled: Boolean(selectedSection && detail)
  });
  const jobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const invalidateWorkData = () => {
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.invalidateQueries({ queryKey: ["audits"] });
    queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
    queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
    queryClient.invalidateQueries({ queryKey: ["sections"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
  };
  const updatePolicy = useMutation({
    mutationFn: ({ titles, policy }: { titles: string[]; policy: StoragePolicyKind }) => api.setStoragePolicies({ titles, policy }),
    onSuccess: () => {
      setSelectedLinkIds([]);
      invalidateWorkData();
    }
  });

  useEffect(() => {
    setExpandedShows({});
    setSearch("");
    setSelectedLinkIds([]);
  }, [selection?.kind, selectedSection, selectedPrefix]);

  const rows = (remoteWorkLinks.data?.rows ?? []).filter((row) => row.isMedia && (row.kind === "remote" || row.kind === "local"));
  const activeJobByLinkId = useMemo(() => {
    const activeJobs = (jobs.data ?? []).filter(isActiveQueueJob);
    return new Map(rows.map((row) => [row.id, activeJobForLink(row, activeJobs)] as const).filter((entry): entry is readonly [number, JobRecord] => Boolean(entry[1])));
  }, [jobs.data, rows]);
  const selectableRows = rows.filter((row) => !activeJobByLinkId.has(row.id) && !titleScopeIsPending(pendingTitleScopes, row.section, row.itemName));
  const visibleLinkIds = rows.map((row) => row.id);
  const selectableLinkIds = selectableRows.map((row) => row.id);
  const selectableLinkIdKey = selectableLinkIds.join(",");
  useEffect(() => {
    const selectableIds = new Set(selectableLinkIdKey ? selectableLinkIdKey.split(",").map(Number) : []);
    setSelectedLinkIds((current) => current.filter((id) => selectableIds.has(id)));
  }, [selectableLinkIdKey]);

  if (!selection || !selectedSection || !detail) return null;

  const sectionTitle = selectedSummary ? sectionDisplayTitle(selectedSummary) : selectedSection;
  const title = selection.scopeLabel ? `${sectionTitle} / ${selection.scopeLabel}` : sectionTitle;
  const showGroups = isShowSection ? groupActionableShows(rows) : [];
  const copyLabel = selectedContentType === "movies" ? "Movie" : "Episode";
  const shownTotal = remoteWorkLinks.data?.total ?? rows.length;
  const copyDestinationLabel = copyDirection === "to_remote" ? remoteName : localName;
  const canCopy = Boolean(copyDirection && selectedSection);
  const canChangeRowPolicy = selectedContentType === "movies";
  const policyButtonState = policyButtonsForWorkKind(selection.kind);
  const actionPending = updatePolicy.isPending;
  const pendingPolicy = actionPending ? updatePolicy.variables?.policy ?? null : null;
  const pendingTitleCount = actionPending ? updatePolicy.variables?.titles.length ?? 0 : 0;
  const pendingPolicyText = pendingPolicy ? storagePolicyActionText(pendingPolicy, storageLocations) : "";
  const selectedLinkIdSet = new Set(selectedLinkIds);
  const selectedLinks = selectableRows.filter((row) => selectedLinkIdSet.has(row.id));
  const selectedTitles = uniqueMediaTitles(selectedLinks);
  const allVisibleSelected = selectableLinkIds.length > 0 && selectableLinkIds.every((id) => selectedLinkIdSet.has(id));
  const activeVisibleJobCount = activeJobsForLinks(rows, activeJobByLinkId).length;
  const activeVisibleLinkCount = rows.length - selectableRows.length;

  function queueCopy(title: string, description: string, options: CopyOptions) {
    onCopyRequest({ key: copyPromptKey(options), title, description, options, autoStart: true });
  }

  function queueAudit(title: string, description: string, options: Omit<AuditOptions, "mode">) {
    onAuditRequest({ title, description, options });
  }

  function queuePolicy(title: string, policy: StoragePolicyKind) {
    updatePolicy.mutate({ titles: [title], policy });
  }

  function queueSelectedCopy() {
    if (!copyDirection || selectedLinks.length === 0) return;
    queueCopy(`Copy ${formatNumber(selectedLinks.length)} selected to ${copyDestinationLabel}`, `${title} / selected links`, { direction: copyDirection, linkIds: selectedLinks.map((link) => link.id) });
  }

  function queueSelectedAudit() {
    if (selectedLinks.length === 0) return;
    queueAudit(`Audit ${formatNumber(selectedLinks.length)} selected`, `${title} / selected links`, { linkIds: selectedLinks.map((link) => link.id) });
  }

  function queueSelectedPolicy(policy: StoragePolicyKind) {
    if (selectedTitles.length === 0) return;
    updatePolicy.mutate({ titles: selectedTitles, policy });
  }

  function toggleLinkSelection(id: number, checked: boolean) {
    setSelectedLinkIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((currentId) => currentId !== id);
    });
  }

  function setLinksSelected(links: MediaLinkRow[], checked: boolean) {
    const ids = links.map((link) => link.id);
    setSelectedLinkIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return [...next];
    });
  }

  function linksSelected(links: MediaLinkRow[]): boolean {
    return links.length > 0 && links.every((link) => selectedLinkIdSet.has(link.id));
  }

  function showLinks(show: ActionableShowGroup): MediaLinkRow[] {
    return show.seasons.flatMap((season) => season.episodes.map((episode) => episode.link));
  }

  function seasonLinks(season: ActionableSeasonGroup): MediaLinkRow[] {
    return season.episodes.map((episode) => episode.link);
  }

  function queueSectionCopy() {
    if (!copyDirection || !selectedSection) return;
    queueCopy(`Copy ${title} to ${copyDestinationLabel}`, `All matching media in ${title}`, { direction: copyDirection, section: selectedSection, ...(selectedPrefix ? { relativePathPrefix: selectedPrefix } : {}) });
  }

  function queueShowCopy(show: ActionableShowGroup) {
    if (!copyDirection || !selectedSection) return;
    queueCopy(`Copy ${show.showName} to ${copyDestinationLabel}`, `${title} / ${show.showName}`, {
      direction: copyDirection,
      section: selectedSection,
      itemName: show.showName,
      ...(selectedPrefix ? { relativePathPrefix: selectedPrefix } : {})
    });
  }

  function queueSeasonCopy(showName: string, season: ActionableSeasonGroup) {
    if (!copyDirection || !selectedSection) return;
    const prefix = scopedRelativePrefix(selectedPrefix, seasonRelativePrefix(season));
    queueCopy(`Copy ${showName} / ${season.seasonName} to ${copyDestinationLabel}`, `${title} / ${showName} / ${season.seasonName}`, {
      direction: copyDirection,
      section: selectedSection,
      itemName: showName,
      ...(prefix ? { relativePathPrefix: prefix } : {})
    });
  }

  function queueLinkCopy(link: MediaLinkRow) {
    if (!copyDirection) return;
    queueCopy(`Copy ${link.itemName} to ${copyDestinationLabel}`, "1 selected link", { direction: copyDirection, linkIds: [link.id] });
  }

  function queueTitleAudit(itemName: string) {
    if (!selectedSection) return;
    queueAudit(`Audit ${itemName}`, `${title} / ${itemName}`, { section: selectedSection, itemName, ...(selectedPrefix ? { relativePathPrefix: selectedPrefix } : {}) });
  }

  function queueSeasonAudit(showName: string, season: ActionableSeasonGroup) {
    if (!selectedSection) return;
    const prefix = scopedRelativePrefix(selectedPrefix, seasonRelativePrefix(season));
    queueAudit(`Audit ${showName} / ${season.seasonName}`, `${title} / ${showName} / ${season.seasonName}`, {
      section: selectedSection,
      itemName: showName,
      ...(prefix ? { relativePathPrefix: prefix } : {})
    });
  }

  function queueLinkAudit(link: MediaLinkRow) {
    queueAudit(`Audit ${link.itemName}`, link.relativePath ? `${title} / ${link.relativePath}` : title, { linkIds: [link.id] });
  }

  return (
    <Panel
      title={`${detail.title} - ${title}`}
      icon={<ListChecks size={18} />}
      actions={
        <button type="button" className="icon-button" title="Close list" aria-label="Close work list" onClick={onClose}>
          <X size={16} />
        </button>
      }
    >
      <div className="actionable-panel-body">
        <div className="actionable-panel-meta">
          <span>
            {detail.descriptionPrefix} <strong>{title}</strong>. {detail.descriptionSuffix}
          </span>
          <div className="actionable-panel-tools">
            <label className="work-search">
              <Search size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work" />
            </label>
            {remoteWorkLinks.data ? (
              <small>
                {isShowSection
                  ? `Showing all ${formatNumber(rows.length)} links across ${formatNumber(showGroups.length)} shows`
                  : `Showing all ${formatNumber(rows.length)}`}
              </small>
            ) : null}
            {canCopy ? (
              <button type="button" className="secondary future-action-button" onClick={queueSectionCopy} disabled={actionPending || shownTotal === 0 || activeVisibleJobCount > 0}>
                <Copy size={14} />
                Copy all to {copyDestinationLabel}
              </button>
            ) : null}
          </div>
        </div>
        {rows.length > 0 ? (
          <BulkActionBar
            selectedCount={selectedLinks.length}
            totalCount={visibleLinkIds.length}
            allSelected={allVisibleSelected}
            onSelectAll={() => setLinksSelected(selectableRows, true)}
            onClear={() => setSelectedLinkIds([])}
            disabled={actionPending}
          >
            {canCopy ? (
              <button type="button" className="secondary future-action-button" onClick={queueSelectedCopy} disabled={actionPending || selectedLinks.length === 0}>
                <Copy size={14} />
                Copy selected to {copyDestinationLabel}
              </button>
            ) : null}
            {policyButtonState.assignLocal ? (
              <button type="button" className="secondary future-action-button" onClick={() => queueSelectedPolicy("location_1")} disabled={actionPending || selectedTitles.length === 0}>
                <HardDrive size={14} />
                {pendingPolicy === "location_1" ? `Assigning ${formatNumber(pendingTitleCount)} title${pendingTitleCount === 1 ? "" : "s"} to ${localName}...` : `Assign selected titles to ${localName}`}
              </button>
            ) : null}
            {policyButtonState.assignRemote ? (
              <button type="button" className="secondary future-action-button" onClick={() => queueSelectedPolicy("location_2")} disabled={actionPending || selectedTitles.length === 0}>
                <HardDriveDownload size={14} />
                {pendingPolicy === "location_2" ? `Assigning ${formatNumber(pendingTitleCount)} title${pendingTitleCount === 1 ? "" : "s"} to ${remoteName}...` : `Assign selected titles to ${remoteName}`}
              </button>
            ) : null}
            <button type="button" className="secondary future-action-button" onClick={queueSelectedAudit} disabled={actionPending || selectedLinks.length === 0}>
              <Activity size={14} />
              Audit selected
            </button>
          </BulkActionBar>
        ) : null}
        {updatePolicy.isPending && pendingPolicy ? (
          <p className="panel-message action-progress">
            <RefreshCw className="spin-icon" size={14} />
            Assigning {formatNumber(pendingTitleCount)} title{pendingTitleCount === 1 ? "" : "s"} to {pendingPolicyText}. Large libraries can take a moment.
          </p>
        ) : null}
        {activeVisibleLinkCount > 0 ? (
          <p className="panel-message job-lock-panel">
            {formatNumber(activeVisibleLinkCount)} visible item{activeVisibleLinkCount === 1 ? "" : "s"} already {activeVisibleLinkCount === 1 ? "has" : "have"} an active job.
            Wait for completion or terminate the job before issuing more actions.
          </p>
        ) : null}
        {updatePolicy.error ? <p className="panel-message action-error">{updatePolicy.error.message}</p> : null}
        {updatePolicy.data ? <p className="panel-message">{formatNumber(updatePolicy.data.updated)} title{updatePolicy.data.updated === 1 ? "" : "s"} assigned to {storagePolicyLabel(updatePolicy.data.policy, storageLocations)}.</p> : null}
        {remoteWorkLinks.isLoading ? (
          <p className="panel-message">Loading {detail.emptyName} symlinks...</p>
        ) : remoteWorkLinks.error ? (
          <p className="panel-message action-error">{remoteWorkLinks.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="panel-message">No {detail.emptyName} symlinks found for this section.</p>
        ) : isShowSection ? (
          <div className="actionable-show-list">
            {showGroups.map((show) => {
              const expanded = Boolean(expandedShows[show.showName]);
              const links = showLinks(show);
              const showActiveJobs = activeJobsForLinks(links, activeJobByLinkId);
              const rescanPending = titleScopeIsPending(pendingTitleScopes, selectedSection, show.showName);
              const sourceRisk = worstSourceTitleRisk(links);
              const sourceRiskCount = riskySourceTitleCount(links);
              return (
                <article key={show.showName} className="actionable-show-group">
                  <div className="actionable-show-row">
                    <label className="bulk-row-select">
                      <input
                        type="checkbox"
                        checked={linksSelected(links)}
                        onChange={(event) => setLinksSelected(links.filter((link) => !activeJobByLinkId.has(link.id)), event.target.checked)}
                        disabled={actionPending || rescanPending || showActiveJobs.length > 0}
                      />
                      <span className="sr-only">Select all links for {show.showName}</span>
                    </label>
                    <button
                      type="button"
                      className="actionable-show-toggle"
                      aria-expanded={expanded}
                      onClick={() => setExpandedShows((current) => ({ ...current, [show.showName]: !current[show.showName] }))}
                    >
                      <span className="actionable-show-title">
                        <ChevronRight size={16} />
                        <strong>{show.showName}</strong>
                        <SourceTitleRiskBadge risk={sourceRisk} count={sourceRiskCount} />
                      </span>
                    </button>
                    {showActiveJobs.length > 0 ? <JobLockBadge jobs={showActiveJobs} className="actionable-show-lock" /> : null}
                    <span className="actionable-show-counts">
                      <span>
                        <strong>{formatNumber(show.seasonCount)}</strong>
                        <small>Seasons</small>
                      </span>
                      <span>
                        <strong>{formatNumber(show.episodeCount)}</strong>
                        <small>Episodes</small>
                      </span>
                    </span>
                    <FutureTitleActions
                      mode={selection.kind}
                      label="Show"
                      itemName={show.showName}
                      destination={copyDestinationLabel}
                      isPending={actionPending || rescanPending}
                      activeJobs={showActiveJobs}
                      hideNotice
                      onCopy={() => queueShowCopy(show)}
                      onAudit={() => queueTitleAudit(show.showName)}
                      onRescan={() => onRescanTitle(selectedSection, show.showName)}
                      rescanPending={rescanPending}
                      onAssignLocal={policyButtonState.assignLocal ? () => queuePolicy(show.showName, "location_1") : undefined}
                      onAssignRemote={policyButtonState.assignRemote ? () => queuePolicy(show.showName, "location_2") : undefined}
                    />
                  </div>
                  {expanded ? (
                    <div className="actionable-season-list">
                      {show.seasons.map((season) => {
                        const links = seasonLinks(season);
                        const seasonActiveJobs = activeJobsForLinks(links, activeJobByLinkId);
                        return (
                          <section key={season.seasonName} className="actionable-season-group">
                            <div className="actionable-season-header">
                              <label className="bulk-row-select">
                                <input
                                  type="checkbox"
                                  checked={linksSelected(links)}
                                  onChange={(event) => setLinksSelected(links.filter((link) => !activeJobByLinkId.has(link.id)), event.target.checked)}
                                  disabled={actionPending || rescanPending || seasonActiveJobs.length > 0}
                                />
                                <span className="sr-only">Select all links for {show.showName} / {season.seasonName}</span>
                              </label>
                              <span>
                                <strong>{season.seasonName}</strong>
                                <small>{formatNumber(season.episodes.length)} episodes</small>
                              </span>
                              <FutureTitleActions
                                mode={selection.kind}
                                label="Season"
                                destination={copyDestinationLabel}
                                isPending={actionPending}
                                activeJobs={seasonActiveJobs}
                                onCopy={() => queueSeasonCopy(show.showName, season)}
                                onAudit={() => queueSeasonAudit(show.showName, season)}
                              />
                            </div>
                            <div className="actionable-episode-list">
                              {season.episodes.map((episode) => {
                                const sourceRisk = sourceTitleRiskForLink(episode.link);
                                return (
                                  <div key={episode.link.id} className="actionable-episode-row">
                                    <label className="bulk-row-select">
                                      <input
                                        type="checkbox"
                                        checked={selectedLinkIdSet.has(episode.link.id)}
                                        onChange={(event) => toggleLinkSelection(episode.link.id, event.target.checked)}
                                        disabled={actionPending || rescanPending || activeJobByLinkId.has(episode.link.id)}
                                      />
                                      <span className="sr-only">Select {episode.episodeName}</span>
                                    </label>
                                    <span className="actionable-episode-name">
                                      <FileText size={15} />
                                      <span className="actionable-title-text">{episode.episodeName}</span>
                                      <SourceTitleRiskBadge risk={sourceRisk} />
                                    </span>
                                    <FutureActions
                                      link={episode.link}
                                      mode={selection.kind}
                                      copyLabel={copyLabel}
                                      destination={copyDestinationLabel}
                                      isPending={actionPending}
                                      activeJob={activeJobByLinkId.get(episode.link.id) ?? null}
                                      onCopy={() => queueLinkCopy(episode.link)}
                                      onAudit={() => queueLinkAudit(episode.link)}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <table className="responsive-table actionable-links-table">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select</span>
                </th>
                <th>Title</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => {
                const sourceRisk = sourceTitleRiskForLink(link);
                const rescanPending = titleScopeIsPending(pendingTitleScopes, selectedSection, link.itemName);
                return (
                  <tr key={link.id}>
                    <td>
                      <label className="bulk-row-select">
                        <input
                          type="checkbox"
                          checked={selectedLinkIdSet.has(link.id)}
                          onChange={(event) => toggleLinkSelection(link.id, event.target.checked)}
                          disabled={actionPending || rescanPending || activeJobByLinkId.has(link.id)}
                        />
                        <span className="sr-only">Select {link.itemName}</span>
                      </label>
                    </td>
                    <td>
                      <span className="actionable-title-with-risk">
                        <strong className="actionable-title-text">{link.itemName}</strong>
                        <SourceTitleRiskBadge risk={sourceRisk} />
                      </span>
                    </td>
                    <td>
                      <FutureActions
                        link={link}
                        mode={selection.kind}
                        copyLabel={copyLabel}
                        destination={copyDestinationLabel}
                        isPending={actionPending || rescanPending}
                        activeJob={activeJobByLinkId.get(link.id) ?? null}
                        onCopy={() => queueLinkCopy(link)}
                        onAudit={() => queueLinkAudit(link)}
                        onRescan={() => onRescanTitle(selectedSection, link.itemName)}
                        rescanPending={rescanPending}
                        onAssignLocal={canChangeRowPolicy && policyButtonState.assignLocal ? () => queuePolicy(link.itemName, "location_1") : undefined}
                        onAssignRemote={canChangeRowPolicy && policyButtonState.assignRemote ? () => queuePolicy(link.itemName, "location_2") : undefined}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function copyDirectionForWorkKind(kind: SectionWorkKind): CopyDirection | null {
  if (kind === "copy_to_local") return "to_local";
  if (kind === "copy_to_remote") return "to_remote";
  return null;
}

function policyButtonsForWorkKind(kind: SectionWorkKind): { assignLocal: boolean; assignRemote: boolean } {
  if (kind === "copy_to_local") return { assignLocal: false, assignRemote: true };
  if (kind === "copy_to_remote") return { assignLocal: true, assignRemote: false };
  return { assignLocal: true, assignRemote: true };
}

function seasonRelativePrefix(season: ActionableSeasonGroup): string | null {
  const firstLink = season.episodes[0]?.link;
  if (!firstLink) return null;
  const parts = splitMediaRelativePath(firstLink.relativePath);
  if (parts.length < 2) return null;
  return parts.slice(0, 2).join("/");
}

function scopedRelativePrefix(selectedPrefix: string, actionPrefix: string | null): string | undefined {
  const selected = splitMediaRelativePath(selectedPrefix).join("/");
  const action = actionPrefix ? splitMediaRelativePath(actionPrefix).join("/") : "";
  if (!selected) return action || undefined;
  if (!action) return selected;
  if (selected === action || selected.startsWith(`${action}/`)) return selected;
  if (action.startsWith(`${selected}/`)) return action;
  return action;
}

function remoteWorkDetail(kind: SectionWorkKind, storageLocations: StorageLocationsSettings): {
  title: string;
  emptyName: string;
  kind?: MediaLinkRow["kind"];
  storagePolicy: StoragePolicyKind;
  descriptionPrefix: string;
  descriptionSuffix: string;
} {
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  if (kind === "policy_needed") {
    return {
      title: "Unassigned",
      emptyName: "policy-needed",
      storagePolicy: "unassigned",
      descriptionPrefix: `${localName} and ${remoteName} media items without a storage policy for`,
      descriptionSuffix: `Assign a destination policy from Storage Policies before copying.`
    };
  }

  if (kind === "copy_to_remote") {
    return {
      title: `Copy To ${remoteName}`,
      emptyName: "copy-to-remote",
      kind: "local",
      storagePolicy: "location_2",
      descriptionPrefix: `${localName} media items assigned to ${remoteName} storage for`,
      descriptionSuffix: "Copy actions will verify the file before repointing symlinks."
    };
  }

  return {
    title: `Copy To ${localName}`,
    emptyName: "copy-to-local",
    kind: "remote",
    storagePolicy: "location_1",
    descriptionPrefix: `${remoteName} media items assigned to ${localName} storage for`,
    descriptionSuffix: "Copy actions will verify the file before repointing symlinks."
  };
}

function groupActionableShows(rows: MediaLinkRow[]): ActionableShowGroup[] {
  const showMap = new Map<string, Map<string, ActionableEpisode[]>>();

  for (const row of rows) {
    const parts = splitMediaRelativePath(row.relativePath);
    const showName = row.itemName || parts[0] || "Unknown show";
    const seasonName = parts.length >= 3 ? parts[1] : "No season folder";
    const episodeName = parts.at(-1) ?? row.itemName;
    const seasonMap = showMap.get(showName) ?? new Map<string, ActionableEpisode[]>();
    const episodes = seasonMap.get(seasonName) ?? [];

    episodes.push({ episodeName, link: row });
    seasonMap.set(seasonName, episodes);
    showMap.set(showName, seasonMap);
  }

  return Array.from(showMap.entries())
    .map(([showName, seasonMap]) => {
      const seasons = Array.from(seasonMap.entries())
        .map(([seasonName, episodes]) => ({
          seasonName,
          episodes: episodes.sort((first, second) => actionableTitleCollator.compare(first.episodeName, second.episodeName))
        }))
        .sort((first, second) => actionableTitleCollator.compare(first.seasonName, second.seasonName));
      return {
        showName,
        seasonCount: seasons.length,
        episodeCount: seasons.reduce((total, season) => total + season.episodes.length, 0),
        seasons
      };
    })
    .sort((first, second) => actionableTitleCollator.compare(first.showName, second.showName));
}

function splitMediaRelativePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

interface TitleRescanTooltipPosition {
  left: number;
  placement: "above" | "below";
  top: number;
}

function titleRescanTooltipPosition(button: HTMLButtonElement): TitleRescanTooltipPosition {
  const rect = button.getBoundingClientRect();
  const viewportPadding = 8;
  const tooltipGap = 7;
  const tooltipWidth = Math.min(260, window.innerWidth - viewportPadding * 2);
  const left = Math.max(viewportPadding, Math.min(rect.right - tooltipWidth, window.innerWidth - tooltipWidth - viewportPadding));
  const placement = rect.top >= 72 ? "above" : "below";
  return {
    left,
    placement,
    top: placement === "above" ? rect.top - tooltipGap : rect.bottom + tooltipGap
  };
}

function RescanTitleButton({ itemName, disabled, pending = false, onClick }: { itemName: string; disabled: boolean; pending?: boolean; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [tooltipPosition, setTooltipPosition] = useState<TitleRescanTooltipPosition | null>(null);
  const tooltipVisible = tooltipPosition !== null;

  useEffect(() => {
    if (!tooltipVisible) return;
    const updatePosition = () => {
      if (buttonRef.current) setTooltipPosition(titleRescanTooltipPosition(buttonRef.current));
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [tooltipVisible]);

  const showTooltip = () => {
    if (buttonRef.current) setTooltipPosition(titleRescanTooltipPosition(buttonRef.current));
  };

  return (
    <span
      className="title-rescan-tooltip"
      onMouseEnter={showTooltip}
      onMouseLeave={() => {
        if (buttonRef.current !== document.activeElement) setTooltipPosition(null);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="icon-button title-rescan-button"
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-label={`Rescan ${itemName}`}
        disabled={disabled}
        onBlur={() => setTooltipPosition(null)}
        onClick={onClick}
        onFocus={showTooltip}
      >
        <RefreshCw className={pending ? "spin-icon" : undefined} size={15} />
      </button>
      {tooltipPosition
        ? createPortal(
            <span
              id={tooltipId}
              className={`title-rescan-tooltip-panel title-rescan-tooltip-panel-${tooltipPosition.placement}`}
              role="tooltip"
              style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
            >
              Rescan this title's symlinks and reconcile replacements without scanning the full folder.
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

function FutureTitleActions({
  mode,
  label,
  itemName,
  destination,
  isPending,
  activeJobs,
  hideNotice = false,
  onCopy,
  onAudit,
  onRescan,
  rescanPending = false,
  onAssignLocal,
  onAssignRemote
}: {
  mode: SectionWorkKind;
  label: "Show" | "Season";
  itemName?: string;
  destination: string;
  isPending: boolean;
  activeJobs?: JobRecord[];
  hideNotice?: boolean;
  onCopy: () => void;
  onAudit: () => void;
  onRescan?: () => void;
  rescanPending?: boolean;
  onAssignLocal?: () => void;
  onAssignRemote?: () => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const activeJobCount = activeJobs?.length ?? 0;
  const disabled = isPending || activeJobCount > 0;
  const notice = activeJobNotice(activeJobs ?? []);
  const showNotice = Boolean(notice && !hideNotice);
  return (
    <div className={`future-actions${showNotice ? " has-job-lock" : ""}`}>
      {showNotice ? <JobLockBadge jobs={activeJobs ?? []} /> : null}
      <span className="future-action-buttons">
        {onRescan ? <RescanTitleButton itemName={itemName ?? label} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {mode !== "policy_needed" ? (
          <button type="button" className="secondary future-action-button" onClick={onCopy} disabled={disabled}>
            <Copy size={14} />
            Copy {label} to {destination}
          </button>
        ) : null}
        {onAssignLocal ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignLocal} disabled={disabled}>
            <HardDrive size={14} />
            Assign {localName}
          </button>
        ) : null}
        {onAssignRemote ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignRemote} disabled={disabled}>
            <Shield size={14} />
            Assign {remoteName}
          </button>
        ) : null}
        <button type="button" className="secondary future-action-button" onClick={onAudit} disabled={disabled}>
          <Activity size={14} />
          Audit
        </button>
      </span>
    </div>
  );
}

function FutureActions({
  link,
  mode,
  copyLabel = "Episode",
  destination,
  isPending,
  activeJob,
  onCopy,
  onAudit,
  onRescan,
  rescanPending = false,
  onAssignLocal,
  onAssignRemote
}: {
  link: MediaLinkRow;
  mode: SectionWorkKind;
  copyLabel?: "Episode" | "Movie";
  destination: string;
  isPending: boolean;
  activeJob?: JobRecord | null;
  onCopy: () => void;
  onAudit: () => void;
  onRescan?: () => void;
  rescanPending?: boolean;
  onAssignLocal?: () => void;
  onAssignRemote?: () => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const disabled = isPending || Boolean(activeJob);
  const notice = activeJob ? activeJobNotice([activeJob]) : null;
  return (
    <div className={`future-actions${notice ? " has-job-lock" : ""}`} aria-label={`Future actions for ${link.itemName}`}>
      {activeJob ? <JobLockBadge jobs={[activeJob]} /> : null}
      <span className="future-action-buttons">
        {onRescan ? <RescanTitleButton itemName={link.itemName} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {mode !== "policy_needed" ? (
          <button type="button" className="secondary future-action-button" onClick={onCopy} disabled={disabled}>
            <Copy size={14} />
            Copy {copyLabel} to {destination}
          </button>
        ) : null}
        {onAssignLocal ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignLocal} disabled={disabled}>
            <HardDrive size={14} />
            Assign {localName}
          </button>
        ) : null}
        {onAssignRemote ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignRemote} disabled={disabled}>
            <Shield size={14} />
            Assign {remoteName}
          </button>
        ) : null}
        <button type="button" className="secondary future-action-button" onClick={onAudit} disabled={disabled}>
          <Activity size={14} />
          Audit
        </button>
      </span>
    </div>
  );
}

function activeJobLockLabel(jobs: JobRecord[]): string | null {
  if (jobs.length === 0) return null;
  if (jobs.length === 1) {
    const job = jobs[0];
    return `Job #${job.id} ${job.status}`;
  }
  return `${jobs.length.toLocaleString()} active jobs`;
}

function JobLockBadge({ jobs, className = "" }: { jobs: JobRecord[]; className?: string }) {
  const detail = activeJobNotice(jobs);
  const label = activeJobLockLabel(jobs);
  if (!detail || !label) return null;
  return (
    <span className={`job-lock-message${className ? ` ${className}` : ""}`} title={detail} aria-label={detail}>
      <TriangleAlert size={13} />
      <span>{label}</span>
    </span>
  );
}

type LibraryView = "overview" | "links" | "local" | "remote" | "local-orphans" | "remote-orphans" | "policies";

export function LibraryPage() {
  const queryClient = useQueryClient();
  const { autoOpenTaskStatus } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [view, setView] = useState<LibraryView>("overview");
  const [kind, setKind] = useState<SymlinkKindFilter>("all");
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedLibraryWork, setSelectedLibraryWork] = useState<SectionWorkSelection | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  const [copyPrompt, setCopyPrompt] = useState<CopyPrompt | null>(null);
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const [treePrefix, setTreePrefix] = useState("");
  const [storagePrefix, setStoragePrefix] = useState("");
  const [policySearch, setPolicySearch] = useState("");
  const [policyFilter, setPolicyFilter] = useState<StoragePolicyKind>("unassigned");
  const isStorageView = view === "local" || view === "remote" || view === "local-orphans" || view === "remote-orphans";
  const storageRoot: StorageRootType = view === "local" || view === "local-orphans" ? "local" : "remote";
  const orphanOnly = view === "local-orphans" || view === "remote-orphans";
  const overview = useQuery({ queryKey: ["inventory-summary"], queryFn: api.inventorySummary, enabled: view === "overview" });
  const sectionSummaries = useQuery({ queryKey: ["sections"], queryFn: api.sections, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const symlinkTree = useQuery({
    queryKey: ["media-link-tree", selectedSection, treePrefix, kind],
    queryFn: () =>
      api.mediaLinkTree({
        section: selectedSection ?? "",
        prefix: treePrefix,
        kind: kind === "all" ? undefined : kind
    }),
    enabled: view === "links" && Boolean(selectedSection)
  });
  const storageTree = useQuery({
    queryKey: ["storage-file-tree", storageRoot, orphanOnly, storagePrefix],
    queryFn: () => api.storageFileTree({ rootType: storageRoot, orphan: orphanOnly, prefix: storagePrefix }),
    enabled: isStorageView
  });
  const storagePolicies = useQuery({
    queryKey: ["storage-policies", policyFilter],
    queryFn: () => api.storagePolicies(policyFilter),
    enabled: view === "policies"
  });
  const jobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), enabled: view === "policies", refetchInterval: 3000 });
  const invalidateInventory = () => {
    queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
    queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
    queryClient.invalidateQueries({ queryKey: ["storage-files"] });
    queryClient.invalidateQueries({ queryKey: ["storage-file-tree"] });
    queryClient.invalidateQueries({ queryKey: ["sections"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
  };
  const setPolicy = useMutation({
    mutationFn: ({ titles, policy }: { titles: string[]; policy: StoragePolicyKind }) => api.setStoragePolicies({ titles, policy }),
    onSuccess: invalidateInventory
  });
  const removePolicy = useMutation({
    mutationFn: api.deleteStoragePolicy,
    onSuccess: invalidateInventory
  });
  const orderedSectionSummaries = orderSectionSummaries(sectionSummaries.data ?? [], sectionSettings.data?.sections);
  const availableScanSections = orderedSectionSummaries.map((section) => ({ section: section.section, title: section.title }));
  const startTitleScan = useMutation({
    mutationFn: (options: ScanOptions) => api.startScan(options),
    onSuccess: async (result, options) => {
      invalidateInventory();
      queryClient.invalidateQueries({ queryKey: ["scans"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-scan-timestamps"] });
      await queryClient.refetchQueries({ queryKey: ["jobs"] });
      if (autoOpenTaskStatus) {
        setScanStatusPrompt({
          key: `scan-job-${result.jobId}`,
          title: "Title rescan",
          description: formatScanScope(options, availableScanSections),
          jobId: result.jobId
        });
      }
    }
  });

  const startCopySilently = useStartCopyJob();
  const copyConflictCheck = useMutation({
    mutationFn: (prompt: CopyPrompt) => {
      if (!prompt.options) throw new Error("Copy options are missing");
      return api.copyConflicts(prompt.options);
    },
    onSuccess: (conflicts, prompt) => {
      if (conflicts.totalConflicts > 0) {
        setCopyPrompt({ ...prompt, conflicts });
        return;
      }
      if (!autoOpenTaskStatus && prompt.autoStart) {
        startCopySilently.mutate(prompt);
        return;
      }
      setCopyPrompt(prompt);
    }
  });

  function handleCopyRequest(prompt: CopyPrompt) {
    if (prompt.options?.direction === "to_local" && !prompt.options.localConflictStrategy) {
      copyConflictCheck.mutate(prompt);
      return;
    }
    if (!autoOpenTaskStatus && prompt.autoStart) {
      startCopySilently.mutate(prompt);
      return;
    }
    setCopyPrompt(prompt);
  }

  function handleSymlinkKindChange(nextKind: SymlinkKindFilter) {
    setKind(nextKind);
    setTreePrefix("");
  }

  function handleLibraryViewChange(nextView: LibraryView) {
    if (nextView !== view && (nextView === "local" || nextView === "remote" || nextView === "local-orphans" || nextView === "remote-orphans")) {
      setStoragePrefix("");
    }
    setView(nextView);
  }

  return (
    <Page title="Library" subtitle="Manual inventory from the last scan.">
      <div className="segmented">
        {[
          { value: "overview", label: "Overview", icon: Database },
          { value: "links", label: "Symlinks", icon: Link2 },
          { value: "local", label: `${localName} files`, icon: HardDrive },
          { value: "remote", label: `${remoteName} files`, icon: HardDriveDownload },
          { value: "local-orphans", label: `${localName} orphans`, icon: Unlink },
          { value: "remote-orphans", label: `${remoteName} orphans`, icon: Unlink },
          { value: "policies", label: "Storage Policies", icon: Shield }
        ].map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.value} className={view === option.value ? "selected" : ""} onClick={() => handleLibraryViewChange(option.value as LibraryView)}>
              <Icon size={15} />
              {option.label}
            </button>
          );
        })}
      </div>
      {startCopySilently.error ? <p className="action-message action-error">{startCopySilently.error.message}</p> : null}
      {copyConflictCheck.error ? <p className="action-message action-error">{copyConflictCheck.error.message}</p> : null}
      {startTitleScan.error ? <p className="action-message action-error">{startTitleScan.error.message}</p> : null}
      {!startCopySilently.error && startCopySilently.data ? <p className="action-message">Copy job #{startCopySilently.data.jobId} queued. View progress from the job list.</p> : null}
      {view === "overview" ? (
        <>
          <LibraryOverview summary={overview.data} isLoading={overview.isLoading} error={overview.error?.message} onSelect={handleLibraryViewChange} />
          {sectionSummaries.error ? <p className="panel-message error">{sectionSummaries.error.message}</p> : null}
          <SectionTable sections={orderedSectionSummaries} selectedRemoteWork={selectedLibraryWork} onRemoteWorkSelect={setSelectedLibraryWork} />
          <RemoteWorkLinksTable
            selection={selectedLibraryWork}
            sections={orderedSectionSummaries}
            pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
            onClose={() => setSelectedLibraryWork(null)}
            onAuditRequest={setAuditPrompt}
            onCopyRequest={handleCopyRequest}
            onRescanTitle={(section, itemName) => startTitleScan.mutate(titleRescanOptions([{ section, itemName }]))}
          />
        </>
      ) : view === "links" ? (
        <>
          <SymlinkBrowser
            sections={orderedSectionSummaries}
            selectedSection={selectedSection}
            kind={kind}
            tree={symlinkTree.data}
            error={sectionSummaries.error?.message ?? symlinkTree.error?.message}
            isLoadingSections={sectionSummaries.isLoading}
            isLoadingTree={symlinkTree.isLoading || symlinkTree.isFetching}
            onKindChange={handleSymlinkKindChange}
            onPrefixChange={setTreePrefix}
            onSectionSelect={(section) => {
              setSelectedSection(section);
              setTreePrefix("");
            }}
            onWorkSelect={setSelectedLibraryWork}
          />
          <RemoteWorkLinksTable
            selection={selectedLibraryWork}
            sections={orderedSectionSummaries}
            pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
            onClose={() => setSelectedLibraryWork(null)}
            onAuditRequest={setAuditPrompt}
            onCopyRequest={handleCopyRequest}
            onRescanTitle={(section, itemName) => startTitleScan.mutate(titleRescanOptions([{ section, itemName }]))}
          />
        </>
      ) : view === "policies" ? (
        <StoragePoliciesPanel
          items={storagePolicies.data ?? []}
          jobs={jobs.data ?? []}
          policy={policyFilter}
          search={policySearch}
          error={storagePolicies.error?.message ?? setPolicy.error?.message ?? removePolicy.error?.message}
          isLoading={storagePolicies.isLoading || storagePolicies.isFetching}
          mutatingTitles={setPolicy.isPending ? setPolicy.variables?.titles ?? [] : []}
          mutatingPolicy={setPolicy.isPending ? setPolicy.variables?.policy ?? null : null}
          copyingTitle={null}
          pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
          copyJobId={null}
          removingId={removePolicy.isPending ? removePolicy.variables ?? null : null}
          onPolicyChange={setPolicyFilter}
          onSearchChange={setPolicySearch}
          onAssign={(title, policy) => setPolicy.mutate({ titles: [title], policy })}
          onAssignMany={(titles, policy) => setPolicy.mutate({ titles, policy })}
          onCopy={(title, direction) =>
            handleCopyRequest({
              key: copyPromptKey({ itemName: title, direction }),
              title: `Copy ${title} to ${direction === "to_local" ? localName : remoteName}`,
              description: title,
              options: { itemName: title, direction },
              autoStart: true
            })
          }
          onAudit={(title) => setAuditPrompt({ title: `Audit ${title}`, description: title, options: { itemName: title } })}
          onRescan={(item) => startTitleScan.mutate(titleRescanOptions(item.sections.map((section) => ({ section, itemName: item.title }))))}
          onRemove={(id) => removePolicy.mutate(id)}
        />
      ) : (
        <StorageFileBrowser
          rootType={storageRoot}
          orphanOnly={orphanOnly}
          tree={storageTree.data}
          error={storageTree.error?.message}
          isLoading={storageTree.isLoading || storageTree.isFetching}
          onPrefixChange={setStoragePrefix}
        />
      )}
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
      <CopyDialog prompt={copyPrompt} onClose={() => setCopyPrompt(null)} />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}

function LibraryOverview({
  summary,
  isLoading,
  error,
  onSelect
}: {
  summary: InventorySummary | undefined;
  isLoading: boolean;
  error?: string;
  onSelect: (view: LibraryView) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const cards = [
    {
      value: "links",
      label: "Symlinks",
      icon: Link2,
      count: summary?.totalLinks,
      detail: `${formatNumber(summary?.remoteLinks ?? 0)} ${remoteName} / ${formatNumber(summary?.localLinks ?? 0)} ${localName}`
    },
    {
      value: "local",
      label: `${localName} files`,
      icon: HardDrive,
      count: summary?.localFiles,
      detail: `${formatNumber(summary?.localOrphanFiles ?? 0)} orphan`
    },
    {
      value: "remote",
      label: `${remoteName} files`,
      icon: HardDriveDownload,
      count: summary?.remoteFiles,
      detail: `${formatNumber(summary?.remoteOrphanFiles ?? 0)} orphan`
    },
    {
      value: "local-orphans",
      label: `${localName} orphans`,
      icon: Unlink,
      count: summary?.localOrphanFiles,
      detail: "No symlink target"
    },
    {
      value: "remote-orphans",
      label: `${remoteName} orphans`,
      icon: Unlink,
      count: summary?.remoteOrphanFiles,
      detail: "No symlink target"
    },
    {
      value: "policies",
      label: "Storage Policies",
      icon: Shield,
      count: summary ? inventoryPolicyNeededCount(summary) : 0,
      detail: `${formatNumber(summary ? inventoryCopyToLocalCount(summary) : 0)} copy to ${localName} / ${formatNumber(summary ? inventoryCopyToRemoteCount(summary) : 0)} copy to ${remoteName}`
    }
  ] as const;

  return (
    <>
      {error ? <p className="panel-message error">{error}</p> : null}
      <div className="library-overview">
        {cards.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.value} className="library-entry" type="button" onClick={() => onSelect(item.value as LibraryView)}>
            <Icon size={18} />
            <span className="library-entry-copy">
              <span>{item.label}</span>
              <strong>{isLoading ? "..." : formatNumber(item.count ?? 0)}</strong>
              <small>{item.detail}</small>
            </span>
          </button>
        );
        })}
      </div>
    </>
  );
}

function SymlinkBrowser({
  sections,
  selectedSection,
  kind,
  tree,
  error,
  isLoadingSections,
  isLoadingTree,
  onKindChange,
  onPrefixChange,
  onSectionSelect,
  onWorkSelect
}: {
  sections: SectionSummary[];
  selectedSection: string | null;
  kind: SymlinkKindFilter;
  tree: MediaLinkTree | undefined;
  error?: string;
  isLoadingSections: boolean;
  isLoadingTree: boolean;
  onKindChange: (kind: SymlinkKindFilter) => void;
  onPrefixChange: (prefix: string) => void;
  onSectionSelect: (section: string) => void;
  onWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [visibleFields, setVisibleFields] = useState({ targetPath: false });
  const [search, setSearch] = useState("");
  const nodes = useMemo(() => tree?.nodes ?? [], [tree?.nodes]);
  const filteredNodes = useMemo(() => filterTreeNodes(nodes, search), [nodes, search]);
  const breadcrumbParts = tree?.prefix ? tree.prefix.split("/").filter(Boolean) : [];
  const canGoBack = Boolean(tree?.prefix);
  const selectedSectionSummary = sections.find((section) => section.section === selectedSection);
  const selectedSectionTitle = selectedSectionSummary ? sectionDisplayTitle(selectedSectionSummary) : selectedSection;
  const selectedSectionType = selectedSectionSummary ? sectionContentType(selectedSectionSummary) : selectedSection ? inferSectionContentType(selectedSection) : "other";
  const isShowSection = selectedSectionType === "shows";
  const showRootSeasonCounts = isShowSection && !tree?.prefix;
  const visibleColumnCount = (isShowSection ? 4 : 3) + (visibleFields.targetPath ? 1 : 0);

  return (
    <>
      <Panel title="Symlink Sections" icon={<Link2 size={18} />}>
        {error ? <p className="panel-message error">{error}</p> : null}
        <div className="section-picker">
          {isLoadingSections ? (
            <p className="panel-message">Loading sections...</p>
          ) : sections.length === 0 ? (
            <p className="panel-message">No symlink sections found.</p>
          ) : (
            sections.map((section) => {
              const title = sectionDisplayTitle(section);
              const type = sectionContentType(section);
              const metrics = type === "shows"
                ? [
                    { label: "Shows", value: section.itemCount },
                    { label: "Seasons", value: section.seasonCount },
                    { label: "Episodes", value: section.episodeCount }
                  ]
                : [
                    { label: nonShowSectionMetricLabel(type), value: section.itemCount },
                    ...(section.episodeCount !== section.itemCount ? [{ label: "Files", value: section.episodeCount }] : [])
                  ];
              return (
                <button
                  key={section.section}
                  type="button"
                  className={selectedSection === section.section ? "section-option selected" : "section-option"}
                  onClick={() => onSectionSelect(section.section)}
                >
                  <span className="section-option-header">
                    <span className="section-option-title">
                      <Folder size={16} />
                      {title}
                    </span>
                  </span>
                  <span className={`section-option-metrics metric-count-${metrics.length}`}>
                    {metrics.map((metric) => (
                      <span key={metric.label} className="section-option-metric">
                        <strong>{formatNumber(metric.value)}</strong>
                        <small>{metric.label}</small>
                      </span>
                    ))}
                  </span>
                  <span className="section-option-detail">
                    <small>{formatNumber(section.remoteLinks)} {remoteName}</small>
                    <small>{formatNumber(section.localLinks)} {localName}</small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Panel>

      <Panel title={selectedSectionTitle ? `Symlinks: ${selectedSectionTitle}` : "Symlink Browser"} icon={<Library size={18} />}>
        <div className="table-toolbar symlink-toolbar">
          <div className="breadcrumb">
            <button className="secondary" type="button" onClick={() => onPrefixChange(tree?.parentPrefix ?? "")} disabled={!canGoBack}>
              <ArrowLeft size={14} />
              Back
            </button>
            {selectedSection ? (
              <>
                <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange("")}>
                  {selectedSectionTitle}
                </button>
                {breadcrumbParts.map((part, index) => {
                  const prefix = breadcrumbParts.slice(0, index + 1).join("/");
                  return (
                    <span key={prefix} className="breadcrumb-part">
                      <ChevronRight size={13} />
                      <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange(prefix)}>
                        {part}
                      </button>
                    </span>
                  );
                })}
              </>
            ) : (
              <span>Select a section</span>
            )}
          </div>
          <div className="symlink-controls">
            <label className="tree-search">
              <Search size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current folder" />
            </label>
            <div className="segmented compact">
              {(["all", "mixed", "remote", "local", "broken"] as const).map((value) => (
                <button key={value} className={kind === value ? "selected" : ""} type="button" onClick={() => onKindChange(value)}>
                  {value === "local" ? localName : value === "remote" ? remoteName : symlinkKindFilterLabels[value]}
                </button>
              ))}
            </div>
            <div className="field-options" role="group" aria-label="Visible fields">
              <span>
                <Settings size={14} />
                Fields
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={visibleFields.targetPath}
                  onChange={(event) => setVisibleFields((current) => ({ ...current, targetPath: event.target.checked }))}
                />
                Target/path
              </label>
            </div>
          </div>
        </div>
        <table className="responsive-table">
          <thead>
            <tr>
              <th>Name</th>
              {isShowSection ? (
                <>
                  <th>Seasons</th>
                  <th>Episodes</th>
                </>
              ) : (
                <th>Links</th>
              )}
              <th>Status</th>
              {visibleFields.targetPath ? <th>Target / path</th> : null}
            </tr>
          </thead>
          <tbody>
            {!selectedSection ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  Select a section.
                </td>
              </tr>
            ) : isLoadingTree && nodes.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  Loading symlinks...
                </td>
              </tr>
            ) : filteredNodes.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  {search.trim() ? "No symlinks match this search." : "No symlinks found."}
                </td>
              </tr>
            ) : (
              filteredNodes.map((node) => (
                <SymlinkTreeRow
                  key={`${node.type}:${node.path}`}
                  node={node}
                  section={selectedSection}
                  isShowSection={isShowSection}
                  showRootSeasonCounts={showRootSeasonCounts}
                  showTargetPath={visibleFields.targetPath}
                  onOpen={onPrefixChange}
                  onWorkSelect={onWorkSelect}
                />
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function filterTreeNodes(nodes: MediaLinkTreeNode[], search: string): MediaLinkTreeNode[] {
  const tokens = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return nodes;
  return nodes.filter((node) => {
    const link = node.link;
    const haystack = [node.name, node.path, link?.itemName, link?.relativePath, link?.targetPath].filter(Boolean).join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function SymlinkTreeRow({
  node,
  section,
  isShowSection,
  showRootSeasonCounts,
  showTargetPath,
  onOpen,
  onWorkSelect
}: {
  node: MediaLinkTreeNode;
  section: string | null;
  isShowSection: boolean;
  showRootSeasonCounts: boolean;
  showTargetPath: boolean;
  onOpen: (prefix: string) => void;
  onWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const seasonValue = showRootSeasonCounts && node.type === "folder" ? formatNumber(node.childFolderCount) : "-";
  if (node.type === "folder") {
    return (
      <tr className="tree-row tree-folder">
        <td>
          <button className="tree-name-button" type="button" onClick={() => onOpen(node.path)}>
            <Folder size={15} />
            <span>{node.name}</span>
            <ChevronRight size={14} />
          </button>
        </td>
        {isShowSection ? (
          <>
            <td>{seasonValue}</td>
            <td>{formatNumber(node.totalLinks)}</td>
          </>
        ) : (
          <td>{formatNumber(node.totalLinks)}</td>
        )}
        <td>
          <LinkCountPills node={node} section={section} onWorkSelect={onWorkSelect} />
        </td>
        {showTargetPath ? <td className="mono narrow muted-path">{node.path}/</td> : null}
      </tr>
    );
  }

  return (
    <tr className="tree-row">
      <td>
        <span className="tree-file-name">
          <File size={15} />
          {node.name}
        </span>
      </td>
      {isShowSection ? (
        <>
          <td>-</td>
          <td>{formatNumber(node.totalLinks)}</td>
        </>
      ) : (
        <td>{formatNumber(node.totalLinks)}</td>
      )}
      <td>
        <LinkCountPills node={node} section={section} onWorkSelect={onWorkSelect} />
      </td>
      {showTargetPath ? <td className="mono narrow">{node.link?.targetPath ?? node.path}</td> : null}
    </tr>
  );
}

function LinkCountPills({ node, section, onWorkSelect }: { node: MediaLinkTreeNode; section: string | null; onWorkSelect: (selection: SectionWorkSelection) => void }) {
  const storageLocations = useStorageLocations();
  const visibleCounts = mediaLinkTreeStatusCounts(node);
  if (visibleCounts.length === 0) return <span className="muted-path">-</span>;
  return (
    <div className="status-cluster">
      {visibleCounts.map(({ label, count, kind: workKind }) => {
        const displayLabel = storageStatusDisplayLabel(label, storageLocations);
        if (workKind && section) {
          return (
            <button
              key={label}
              type="button"
              className="status-count status-count-button"
              onClick={() => onWorkSelect({ section, kind: workKind, relativePathPrefix: node.path, scopeLabel: node.path })}
            >
              <StatusPill value={displayLabel} toneValue={label} />
              {count > 1 ? <span>{formatNumber(count)}</span> : null}
            </button>
          );
        }

        return (
          <span key={label} className="status-count">
            <StatusPill value={displayLabel} toneValue={label} />
            {count > 1 ? <span>{formatNumber(count)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function storageBrowserTitle(rootType: StorageRootType, orphanOnly: boolean, rootLabel: string): string {
  return orphanOnly ? `${rootLabel} orphan files` : `${rootLabel} files`;
}

function formatStorageModified(value: number | null, timeFormat: TimeFormatPreference): string {
  return value == null ? "-" : formatDate(new Date(value).toISOString(), timeFormat);
}

function StorageFileBrowser({
  rootType,
  orphanOnly,
  tree,
  error,
  isLoading,
  onPrefixChange
}: {
  rootType: StorageRootType;
  orphanOnly: boolean;
  tree: StorageFileTree | undefined;
  error?: string;
  isLoading: boolean;
  onPrefixChange: (prefix: string) => void;
}) {
  const storageLocations = useStorageLocations();
  const rootLabel = storageLocationName(storageLocations, rootType);
  const [visibleFields, setVisibleFields] = useState({ fullPath: false });
  const title = storageBrowserTitle(rootType, orphanOnly, rootLabel);
  const Icon = rootType === "remote" ? HardDriveDownload : HardDrive;
  const nodes = tree?.nodes ?? [];
  const breadcrumbParts = tree?.prefix ? tree.prefix.split("/").filter(Boolean) : [];
  const canGoBack = Boolean(tree?.prefix);
  const visibleColumnCount = 6 + (visibleFields.fullPath ? 1 : 0);

  return (
    <Panel title={title} icon={<Icon size={18} />}>
      {error ? <p className="panel-message error">{error}</p> : null}
      <div className="table-toolbar symlink-toolbar">
        <div className="breadcrumb">
          <button className="secondary" type="button" onClick={() => onPrefixChange(tree?.parentPrefix ?? "")} disabled={!canGoBack}>
            <ArrowLeft size={14} />
            Back
          </button>
          <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange("")}>
            {title}
          </button>
          {breadcrumbParts.map((part, index) => {
            const prefix = breadcrumbParts.slice(0, index + 1).join("/");
            return (
              <span key={prefix} className="breadcrumb-part">
                <ChevronRight size={13} />
                <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange(prefix)}>
                  {part}
                </button>
              </span>
            );
          })}
        </div>
        <div className="symlink-controls">
          <div className="field-options" role="group" aria-label="Visible fields">
            <span>
              <Settings size={14} />
              Fields
            </span>
            <label>
              <input
                type="checkbox"
                checked={visibleFields.fullPath}
                onChange={(event) => setVisibleFields((current) => ({ ...current, fullPath: event.target.checked }))}
              />
              Full path
            </label>
          </div>
        </div>
      </div>
      <table className="responsive-table storage-tree-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Files</th>
            <th>Links</th>
            <th>Size</th>
            <th>Modified</th>
            <th>Status</th>
            {visibleFields.fullPath ? <th>Full path</th> : null}
          </tr>
        </thead>
        <tbody>
          {isLoading && nodes.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={visibleColumnCount}>
                Loading files...
              </td>
            </tr>
          ) : nodes.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={visibleColumnCount}>
                No files found.
              </td>
            </tr>
          ) : (
            nodes.map((node) => (
              <StorageFileTreeRow key={`${node.type}:${node.path}`} node={node} showFullPath={visibleFields.fullPath} onOpen={onPrefixChange} />
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function StorageFileTreeRow({ node, showFullPath, onOpen }: { node: StorageFileTreeNode; showFullPath: boolean; onOpen: (prefix: string) => void }) {
  const { timeFormat } = useUserPreferences();
  if (node.type === "folder") {
    return (
      <tr className="tree-row tree-folder">
        <td>
          <button className="tree-name-button" type="button" onClick={() => onOpen(node.path)}>
            <Folder size={15} />
            <span>{node.name}</span>
            <ChevronRight size={14} />
          </button>
          <div className="storage-mobile-status">
            <StorageStatusCounts node={node} />
          </div>
        </td>
        <td>{formatNumber(node.totalFiles)}</td>
        <td>{formatNumber(node.linkedFiles)}</td>
        <td>{formatBytes(node.sizeBytes)}</td>
        <td>{formatStorageModified(node.mtimeMs, timeFormat)}</td>
        <td>
          <StorageStatusCounts node={node} />
        </td>
        {showFullPath ? <td className="mono narrow muted-path">{node.path}/</td> : null}
      </tr>
    );
  }

  const file = node.file;
  const linkCount = file?.linkCount ?? node.linkedFiles;
  return (
    <tr className="tree-row">
      <td>
        <span className="tree-file-name">
          <File size={15} />
          {node.name}
        </span>
        <div className="storage-mobile-status">
          <StorageFileStatus file={file ?? null} fallbackLinked={node.linkedFiles > 0} />
        </div>
      </td>
      <td>{formatNumber(node.totalFiles)}</td>
      <td>{formatNumber(linkCount)}</td>
      <td>{formatBytes(node.sizeBytes)}</td>
      <td>{formatStorageModified(node.mtimeMs, timeFormat)}</td>
      <td>
        <StorageFileStatus file={file ?? null} fallbackLinked={node.linkedFiles > 0} />
      </td>
      {showFullPath ? <td className="mono narrow">{file?.filePath ?? node.path}</td> : null}
    </tr>
  );
}

function StorageStatusCounts({ node }: { node: StorageFileTreeNode }) {
  const storageLocations = useStorageLocations();
  const counts = [
    ["linked", node.linkedFiles],
    ["orphan", node.orphanFiles],
    ["Copy To Local", node.actionableRemoteFiles],
    ["Copy To Remote", node.actionableLocalFiles],
    ["Location 2", node.assignedRemoteFiles]
  ] as const;
  const visibleCounts = counts.filter(([, count]) => count > 0);
  if (visibleCounts.length === 0) return <span className="muted-path">-</span>;
  return (
    <div className="status-cluster">
      {visibleCounts.map(([label, count]) => (
        <span key={label} className="status-count">
          <StatusPill value={storageStatusDisplayLabel(label, storageLocations)} toneValue={label} />
          {count > 1 ? <span>{formatNumber(count)}</span> : null}
        </span>
      ))}
    </div>
  );
}

function StorageFileStatus({ file, fallbackLinked }: { file: StorageFileRow | null; fallbackLinked: boolean }) {
  const storageLocations = useStorageLocations();
  const linked = file?.linked ?? fallbackLinked;
  const policy = file?.storagePolicy ?? "unassigned";
  const rootType = file?.rootType ?? null;
  const policyLabel =
    !linked && rootType === "remote" && policy === "location_1"
      ? "Copy To Local"
      : !linked && rootType === "local" && policy === "location_2"
        ? "Copy To Remote"
        : !linked && rootType === "remote" && policy === "location_2"
          ? "Location 2"
          : null;
  return (
    <div className="status-cluster">
      <span className="status-count">
        <StatusPill value={linked ? "linked" : "orphan"} />
      </span>
      {policyLabel ? (
        <span className="status-count">
          <StatusPill value={storageStatusDisplayLabel(policyLabel, storageLocations)} toneValue={policyLabel} />
        </span>
      ) : null}
    </div>
  );
}

function filterStoragePolicyItems(items: StoragePolicyTitle[], search: string, storageLocations: StorageLocationsSettings): StoragePolicyTitle[] {
  const tokens = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return items;
  return items.filter((item) => {
    const haystack = [item.title, item.category, storagePolicyLabel(item.policy, storageLocations), ...item.sections].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function StoragePoliciesPanel({
  items,
  jobs,
  policy,
  search,
  error,
  isLoading,
  mutatingTitles,
  mutatingPolicy,
  copyingTitle,
  pendingTitleScopes,
  copyJobId,
  removingId,
  onPolicyChange,
  onSearchChange,
  onAssign,
  onAssignMany,
  onCopy,
  onAudit,
  onRescan,
  onRemove
}: {
  items: StoragePolicyTitle[];
  jobs: JobRecord[];
  policy: StoragePolicyKind;
  search: string;
  error?: string;
  isLoading: boolean;
  mutatingTitles: string[];
  mutatingPolicy: StoragePolicyKind | null;
  copyingTitle: string | null;
  pendingTitleScopes?: ScanTitleScope[];
  copyJobId: number | null;
  removingId: number | null;
  onPolicyChange: (policy: StoragePolicyKind) => void;
  onSearchChange: (title: string) => void;
  onAssign: (title: string, policy: StoragePolicyKind) => void;
  onAssignMany: (titles: string[], policy: StoragePolicyKind) => void;
  onCopy: (title: string, direction: CopyDirection) => void;
  onAudit: (title: string) => void;
  onRescan: (item: StoragePolicyTitle) => void;
  onRemove: (id: number) => void;
}) {
  const { timeFormat } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const storagePolicyTabs: Array<{ value: StoragePolicyKind; label: string; detail: string }> = [
    { value: "unassigned", label: "Unassigned", detail: "Titles waiting for a destination policy" },
    { value: "location_1", label: localName, detail: `Content assigned here should reside on ${localName}` },
    { value: "location_2", label: remoteName, detail: `Content assigned here should reside on ${remoteName}` }
  ];
  const [selectedTitleKeys, setSelectedTitleKeys] = useState<string[]>([]);
  const filteredItems = filterStoragePolicyItems(items, search, storageLocations);
  const activeQueueJobs = useMemo(() => jobs.filter(isActiveQueueJob), [jobs]);
  const activeJobsByTitleKey = useMemo(() => {
    return new Map(
      filteredItems
        .map((item) => [item.normalizedTitle, activeJobsForStoragePolicyTitle(item, activeQueueJobs)] as const)
        .filter((entry) => entry[1].length > 0)
    );
  }, [activeQueueJobs, filteredItems]);
  const pendingTitleKeys = new Set(
    filteredItems
      .filter((item) => pendingTitleScopes?.some((scope) => item.sections.includes(scope.section) && scope.itemName === item.title))
      .map((item) => item.normalizedTitle)
  );
  const selectableItems = filteredItems.filter((item) => !activeJobsByTitleKey.has(item.normalizedTitle) && !pendingTitleKeys.has(item.normalizedTitle));
  const selectableTitleKeys = selectableItems.map((item) => item.normalizedTitle);
  const selectableTitleKey = selectableTitleKeys.join("|");
  useEffect(() => {
    const selectableKeys = new Set(selectableTitleKey ? selectableTitleKey.split("|") : []);
    setSelectedTitleKeys((current) => current.filter((key) => selectableKeys.has(key)));
  }, [selectableTitleKey]);
  const selectedTitleKeySet = new Set(selectedTitleKeys);
  const selectedItems = selectableItems.filter((item) => selectedTitleKeySet.has(item.normalizedTitle));
  const selectedTitles = uniqueTitles(selectedItems.map((item) => item.title));
  const allVisibleSelected = selectableTitleKeys.length > 0 && selectableTitleKeys.every((key) => selectedTitleKeySet.has(key));
  const mutatingTitleSet = new Set(mutatingTitles);
  const isMutatingPolicy = mutatingTitles.length > 0 && Boolean(mutatingPolicy);
  const mutatingPolicyText = mutatingPolicy ? storagePolicyActionText(mutatingPolicy, storageLocations) : "";
  const emptyLabel = search.trim()
    ? "No matching titles."
    : policy === "unassigned"
      ? "No titles need a storage policy."
      : `No titles are assigned to ${policy === "location_1" ? localName : remoteName}.`;
  const activeVisibleTitleCount = filteredItems.length - selectableItems.length;

  function toggleTitleSelection(item: StoragePolicyTitle, checked: boolean) {
    if (activeJobsByTitleKey.has(item.normalizedTitle) || pendingTitleKeys.has(item.normalizedTitle)) return;
    setSelectedTitleKeys((current) => {
      if (checked) return current.includes(item.normalizedTitle) ? current : [...current, item.normalizedTitle];
      return current.filter((key) => key !== item.normalizedTitle);
    });
  }

  function selectAllVisibleTitles() {
    setSelectedTitleKeys(selectableTitleKeys);
  }

  return (
    <Panel title={`Storage Policies (${items.length})`} icon={<Shield size={18} />}>
      <div className="policy-toolbar">
        <div className="policy-tabs" role="tablist" aria-label="Storage policy groups">
          {storagePolicyTabs.map((tab) => (
            <button key={tab.value} type="button" className={policy === tab.value ? "selected" : ""} aria-selected={policy === tab.value} onClick={() => onPolicyChange(tab.value)}>
              <strong>{tab.label}</strong>
              <small>{tab.detail}</small>
            </button>
          ))}
        </div>
        <label className="policy-search">
          Search titles
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Filter scanned titles" autoComplete="off" />
        </label>
      </div>
      {filteredItems.length > 0 ? (
        <BulkActionBar selectedCount={selectedItems.length} totalCount={filteredItems.length} allSelected={allVisibleSelected} onSelectAll={selectAllVisibleTitles} onClear={() => setSelectedTitleKeys([])} disabled={isMutatingPolicy}>
          {policy !== "location_1" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "location_1")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <HardDrive size={14} />
              {mutatingPolicy === "location_1" ? `Assigning ${formatNumber(mutatingTitles.length)} title${mutatingTitles.length === 1 ? "" : "s"} to ${localName}...` : `Assign selected to ${localName}`}
            </button>
          ) : null}
          {policy !== "location_2" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "location_2")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <HardDriveDownload size={14} />
              {mutatingPolicy === "location_2" ? `Assigning ${formatNumber(mutatingTitles.length)} title${mutatingTitles.length === 1 ? "" : "s"} to ${remoteName}...` : `Assign selected to ${remoteName}`}
            </button>
          ) : null}
          {policy !== "unassigned" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "unassigned")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <Shield size={14} />
              {mutatingPolicy === "unassigned" ? `Unassigning ${formatNumber(mutatingTitles.length)}...` : "Unassign selected"}
            </button>
          ) : null}
        </BulkActionBar>
      ) : null}
      {isMutatingPolicy ? (
        <p className="panel-message action-progress">
          <RefreshCw className="spin-icon" size={14} />
          Assigning {formatNumber(mutatingTitles.length)} title{mutatingTitles.length === 1 ? "" : "s"} to {mutatingPolicyText}. Large libraries can take a moment.
        </p>
      ) : null}
      {activeVisibleTitleCount > 0 ? (
        <p className="panel-message job-lock-panel">
          {formatNumber(activeVisibleTitleCount)} visible title{activeVisibleTitleCount === 1 ? "" : "s"} already {activeVisibleTitleCount === 1 ? "has" : "have"} an active job.
          Wait for completion or terminate the job before issuing more actions.
        </p>
      ) : null}
      {error ? <p className="panel-message error">{error}</p> : null}
      {copyJobId ? <p className="panel-message">Copy job #{copyJobId} queued.</p> : null}
      <table className="responsive-table">
        <thead>
          <tr>
            <th>
              <span className="sr-only">Select</span>
            </th>
            <th>Title</th>
            <th>Category</th>
            <th>Media</th>
            <th>Policy</th>
            <th>Updated</th>
            <th className="actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td className="empty-state" colSpan={7}>
                Loading storage policies...
              </td>
            </tr>
          ) : filteredItems.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={7}>
                {emptyLabel}
              </td>
            </tr>
          ) : (
            filteredItems.map((item) => (
              <tr key={`${item.policy}-${item.normalizedTitle}`}>
                <td>
                  <label className="bulk-row-select">
                    <input
                      type="checkbox"
                      checked={selectedTitleKeySet.has(item.normalizedTitle)}
                      onChange={(event) => toggleTitleSelection(item, event.target.checked)}
                      disabled={isMutatingPolicy || activeJobsByTitleKey.has(item.normalizedTitle) || pendingTitleKeys.has(item.normalizedTitle)}
                    />
                    <span className="sr-only">Select {item.title}</span>
                  </label>
                </td>
                <td>{item.title}</td>
                <td>
                  <span className={`category-badge category-${item.category}`}>
                    {storagePolicyCategoryLabels[item.category]}
                  </span>
                </td>
                <td>
                  {formatNumber(item.linkCount)} links / {formatNumber(item.fileCount)} files
                  <small className="table-cell-detail">
                    {formatNumber(item.remoteLinkCount + item.remoteFileCount)} {remoteName} / {formatNumber(item.localLinkCount + item.localFileCount)} {localName}
                  </small>
                </td>
                <td>
                  <StatusPill
                    value={storagePolicyLabel(item.policy, storageLocations)}
                    toneValue={item.policy}
                  />
                </td>
                <td>{formatDate(item.updatedAt, timeFormat)}</td>
                <td className="actions-cell">
                  <PolicyActions
                    item={item}
                    mutatingTitleSet={mutatingTitleSet}
                    copyingTitle={copyingTitle}
                    activeJobs={activeJobsByTitleKey.get(item.normalizedTitle) ?? []}
                    rescanPending={Boolean(pendingTitleScopes?.some((scope) => item.sections.includes(scope.section) && scope.itemName === item.title))}
                    removingId={removingId}
                    onAssign={onAssign}
                    onCopy={onCopy}
                    onAudit={onAudit}
                    onRescan={() => onRescan(item)}
                    onRemove={onRemove}
                  />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function PolicyActions({
  item,
  mutatingTitleSet,
  copyingTitle,
  activeJobs,
  rescanPending,
  removingId,
  onAssign,
  onCopy,
  onAudit,
  onRescan,
  onRemove
}: {
  item: StoragePolicyTitle;
  mutatingTitleSet: Set<string>;
  copyingTitle: string | null;
  activeJobs: JobRecord[];
  rescanPending: boolean;
  removingId: number | null;
  onAssign: (title: string, policy: StoragePolicyKind) => void;
  onCopy: (title: string, direction: CopyDirection) => void;
  onAudit: (title: string) => void;
  onRescan: () => void;
  onRemove: (id: number) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const disabled =
    mutatingTitleSet.has(item.title) ||
    copyingTitle === item.title ||
    rescanPending ||
    (item.id != null && removingId === item.id) ||
    activeJobs.length > 0;
  const notice = activeJobNotice(activeJobs);
  const canAssign = item.linkCount + item.fileCount > 0;
  const canAudit = item.linkCount > 0;
  return (
    <div className={`future-actions policy-actions${notice ? " has-job-lock" : ""}`}>
      {notice ? <JobLockBadge jobs={activeJobs} /> : null}
      <span className="future-action-buttons">
        {canAudit ? <RescanTitleButton itemName={item.title} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {item.policy === "location_1" && item.remoteLinkCount > 0 ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onCopy(item.title, "to_local")}>
            <Copy size={14} />
            Copy to {localName}
          </button>
        ) : null}
        {item.policy === "location_2" && item.localLinkCount > 0 ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onCopy(item.title, "to_remote")}>
            <Copy size={14} />
            Copy to {remoteName}
          </button>
        ) : null}
        {canAudit ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAudit(item.title)}>
            <Activity size={14} />
            Audit
          </button>
        ) : null}
        {canAssign && item.policy !== "location_1" ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAssign(item.title, "location_1")}>
            <HardDrive size={14} />
            Assign to {localName}
          </button>
        ) : null}
        {canAssign && item.policy !== "location_2" ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAssign(item.title, "location_2")}>
            <HardDriveDownload size={14} />
            Assign to {remoteName}
          </button>
        ) : null}
        {item.id != null ? (
          <button className="icon-button danger" type="button" title={`Unassign ${item.title}`} disabled={disabled} onClick={() => onRemove(item.id!)}>
            <Trash2 size={15} />
            <span className="sr-only">Unassign {item.title}</span>
          </button>
        ) : null}
      </span>
    </div>
  );
}
