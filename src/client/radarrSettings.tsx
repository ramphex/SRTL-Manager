import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronLeft, ChevronRight, Eye, LoaderCircle, Plug, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { RadarrMovieStatus, RadarrSettingsInput, RadarrState } from "../shared/radarr";
import type { SectionSettings } from "../shared/types";
import { api } from "./api";
import { InfoTooltip } from "./App";
import { formatDate, storagePolicyLabel, useStorageLocations, type ScanStatusPrompt } from "./appShared";
import { ScanStatusDialog } from "./jobPresentation";
import { SettingsTabs } from "./settingsTabs";

const queryKey = ["radarr"];
const policyMutationKey = ["radarr", "policies"];
const settingsFormId = "radarr-settings-form";
const selectionLimit = 1000;
const statusLabels: Record<RadarrMovieStatus["status"], string> = { unmapped: "Unmapped", review: "Needs review", pending: "Pending", synced: "Synced", error: "Retrying" };

function RadarrFieldLabel({ id, label, help }: { id: string; label: string; help: string }) {
  return <div className="radarr-field-label"><label htmlFor={id}>{label}</label><InfoTooltip label={`About ${label}`}>{help}</InfoTooltip></div>;
}

const tabStorageKey = "srtl-radarr-settings-tab";
const radarrTabs = [
  { key: "connection", label: "Connection" },
  { key: "mappings", label: "Folder mappings" },
  { key: "policy", label: "Policy sync" },
  { key: "monitoring", label: "Copy monitoring" },
  { key: "webhooks", label: "Webhooks" },
  { key: "activity", label: "Activity" }
] as const;
type RadarrTab = (typeof radarrTabs)[number]["key"];

function readStoredTab(): RadarrTab {
  try {
    const stored = window.localStorage.getItem(tabStorageKey);
    return radarrTabs.find((tab) => tab.key === stored)?.key ?? "connection";
  } catch {
    return "connection";
  }
}

export function RadarrSettingsPanel({ active }: { active: boolean }) {
  const state = useQuery({ queryKey, queryFn: api.getRadarr, refetchInterval: active ? 5000 : false });
  const sections = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [scanPrompt, setScanPrompt] = useState<ScanStatusPrompt | null>(null);
  // Held above the configuration because saving remounts it with the new revision.
  const [tab, setTab] = useState<RadarrTab>(readStoredTab);
  const selectTab = (next: RadarrTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(tabStorageKey, next);
    } catch {
      // The selected tab still applies for this page view when storage is restricted.
    }
  };
  if (state.isLoading || sections.isLoading) return <p role="status">Loading integrations...</p>;
  if (!state.data || !sections.data) return <p className="error" role="alert">{state.error?.message ?? sections.error?.message ?? "Integration settings unavailable."}</p>;
  return <>
    {state.error ? <p className="error" role="alert">{state.error.message}</p> : null}
    <RadarrConfiguration key={state.data.settings.revision} state={state.data} sections={sections.data} tab={tab} onTabSelect={selectTab} onScanJobSelect={setScanPrompt} />
    <ScanStatusDialog prompt={scanPrompt} onClose={() => setScanPrompt(null)} />
  </>;
}

function RadarrTabPanel({ tab, active, children }: { tab: RadarrTab; active: RadarrTab; children: ReactNode }) {
  return <div role="tabpanel" id={`radarr-panel-${tab}`} aria-labelledby={`radarr-tab-${tab}`} data-tab={tab} hidden={tab !== active} className="radarr-tab-panel">{children}</div>;
}

function RadarrConfiguration({ state, sections, tab, onTabSelect, onScanJobSelect }: { state: RadarrState; sections: SectionSettings; tab: RadarrTab; onTabSelect: (tab: RadarrTab) => void; onScanJobSelect: (prompt: ScanStatusPrompt) => void }) {
  const { settings } = state;
  const queryClient = useQueryClient();
  const locations = useStorageLocations();
  const policyBusy = useIsMutating({ mutationKey: policyMutationKey }) > 0;
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<RadarrSettingsInput>({ ...settings, apiKey: "", webhookSecret: "" });
  const update = <K extends keyof RadarrSettingsInput>(key: K, value: RadarrSettingsInput[K]) => {
    if (key === "baseUrl" || key === "apiKey") testConnection.reset();
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const input = { ...draft, mappings: draft.mappingMode === "auto" ? settings.mappings : draft.mappings };
  const testConnection = useMutation({ mutationFn: () => api.testRadarr({ ...input, enabled: false }) });
  const save = useMutation({ mutationFn: () => api.saveRadarr(input), onSuccess: (state) => {
    queryClient.setQueryData(queryKey, state);
    void queryClient.invalidateQueries({ queryKey: ["radarr-copy-defaults"] });
  } });
  const busy = save.isPending || testConnection.isPending;
  const fieldsDisabled = busy || policyBusy;
  const unsavedTabs: Record<RadarrTab, boolean> = {
    connection: draft.baseUrl !== settings.baseUrl || Boolean(draft.apiKey),
    mappings: draft.mappingMode !== settings.mappingMode || (draft.mappingMode === "manual" && (draft.mappings.length !== settings.mappings.length || draft.mappings.some((mapping, index) => mapping.rootPath !== settings.mappings[index]?.rootPath || mapping.section !== settings.mappings[index]?.section))),
    policy: draft.localTag !== settings.localTag || draft.remoteTag !== settings.remoteTag,
    monitoring: draft.monitorOnCopy !== settings.monitorOnCopy,
    webhooks: Boolean(draft.webhookSecret),
    activity: false
  };
  const hasUnsavedChanges = draft.enabled !== settings.enabled || Object.values(unsavedTabs).some(Boolean);
  const tabs = radarrTabs.map(({ key, label }) => ({ key, label: <>{label}{unsavedTabs[key] ? <span className="settings-tab-unsaved" title="Unsaved changes"><span className="sr-only">(unsaved changes)</span></span> : null}</> }));
  const configuredSections = sections.sections.filter((section) => sections.sectionTypes?.[section] === "movies");
  const detectedMappings = testConnection.data?.automaticMappings ?? (settings.mappingMode === "auto" && draft.baseUrl === settings.baseUrl && !draft.apiKey ? settings.mappings : []);
  const webhookUrl = `${window.location.origin}/api/integrations/radarr/webhook`;
  const revealInvalidField = (event: MouseEvent<HTMLButtonElement>) => {
    const field = Array.from(formRef.current?.elements ?? []).find((element): element is HTMLInputElement | HTMLSelectElement => (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.willValidate && !element.validity.valid);
    const panel = field?.closest<HTMLElement>('[role="tabpanel"]');
    // Fields on hidden tabs still belong to the form, but the browser cannot point at one it cannot show.
    if (!field || !panel?.hidden || !panel.dataset.tab) return;
    event.preventDefault();
    flushSync(() => onTabSelect(panel.dataset.tab as RadarrTab));
    field.focus();
    field.reportValidity();
  };
  return <div className="radarr-settings">
    {/* Only configuration controls belong to this form; policy actions remain independent. */}
    <form ref={formRef} id={settingsFormId} hidden onSubmit={(event) => { event.preventDefault(); if (!fieldsDisabled) save.mutate(); }} />
    <header className="radarr-integration-header">
      <div className="radarr-heading">
        <div className="radarr-heading-identity"><h2><Plug size={18} />Radarr</h2><span className="radarr-state">Current: {settings.enabled ? "Enabled" : settings.hasApiKey ? "Paused" : "Not connected"}</span></div>
        <div className="radarr-save-area">
          <span className={`radarr-save-status${hasUnsavedChanges && !save.isPending ? " radarr-save-status-unsaved" : ""}`} role="status">{save.isPending ? "Saving settings..." : hasUnsavedChanges ? "Unsaved changes" : settings.hasApiKey ? "No unsaved changes" : "Not configured"}</span>
          <button type="submit" form={settingsFormId} disabled={fieldsDisabled} onClick={revealInvalidField}>{save.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Save size={16} />}Save Radarr settings</button>
        </div>
      </div>
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <div className="radarr-help-heading radarr-enable"><label className="radarr-toggle"><input form={settingsFormId} type="checkbox" disabled={fieldsDisabled} checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />Enable integration</label><InfoTooltip label="About enabling integration">Off by default. Save Radarr settings to apply this change. Enabling keeps your two policy tags in Radarr matched to SRTL policies, applies copy monitoring updates, and processes webhooks when a secret is saved. Pausing stops future processing, but does not terminate scan jobs already queued.</InfoTooltip></div>
      <details className="radarr-setup">
        <summary>Setup guide and requirements</summary>
        <ol>
          <li><strong>Connect:</strong> enter a URL reachable from the SRTL API and worker, plus the API key from Radarr Settings &gt; General &gt; Security. These are required to test or save a paused connection.</li>
          <li><strong>Prepare synchronization:</strong> Automatic mapping detects identical root paths when you test or save. Review the matches, or select Manual if container paths differ. At least one mapping and two distinct policy tags are required before enabling. Tag placeholders are examples, not active settings.</li>
          <li><strong>Enable:</strong> titles without either policy tag are tagged from their SRTL policy right away. Titles that already carry the other policy tag wait in Needs review: change their policy in SRTL, or select them and choose Use SRTL policies or Import existing tags. Every policy you set afterward updates Radarr. Other tags are never removed, and no files are copied.</li>
          <li><strong>Choose copy monitoring:</strong> copying a movie to local can unmonitor it in Radarr, and copying it back to remote monitors it again. Pick the default here; each copy can override it.</li>
          <li><strong>Optional notifications:</strong> to rescan titles after Radarr imports, add a webhook secret, then in Radarr Settings &gt; Connect &gt; Webhook use POST with the URL below. Add the custom header <code>X-SRTL-Webhook-Secret</code> with the same secret. Select On Import, On Upgrade, and On Rename, then test and save. The URL must be reachable from Radarr.</li>
        </ol>
      </details>
    </header>
    <div className="radarr-tabs-area">
      <SettingsTabs label="Radarr settings" idPrefix="radarr" className="radarr-tabs" tabs={tabs} active={tab} onSelect={onTabSelect} />
      <RadarrTabPanel tab="connection" active={tab}>
        <section className="radarr-section" aria-labelledby="radarr-connection-heading">
          <div className="radarr-heading"><h2 id="radarr-connection-heading">Connection</h2></div>
          <p className="radarr-lede">Where SRTL reaches Radarr. Test the connection before saving.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><RadarrFieldLabel id="radarr-url" label="Radarr URL" help="Required. Use the address reachable from both SRTL services, including any Radarr URL base. In Docker, localhost means that container, not the host. Prefer HTTPS or a trusted private network." /><input form={settingsFormId} id="radarr-url" type="url" required value={draft.baseUrl} placeholder="http://radarr:7878" onChange={(event) => update("baseUrl", event.target.value)} /></div>
              <div className="radarr-field"><RadarrFieldLabel id="radarr-api-key" label="API key" help="Required for the first connection. Find it in Radarr Settings > General > Security. Saved keys are hidden; leave this blank to keep the saved key. Changing the URL requires re-entering the key." /><input form={settingsFormId} id="radarr-api-key" type="password" autoComplete="new-password" required={!settings.hasApiKey || draft.baseUrl !== settings.baseUrl} value={draft.apiKey} placeholder={settings.hasApiKey ? "Saved; leave blank to keep" : "Radarr API key"} onChange={(event) => update("apiKey", event.target.value)} /></div>
            </div>
            <div className="radarr-toolbar">
              <button type="button" className="secondary" disabled={!draft.baseUrl || (!draft.apiKey && !settings.hasApiKey)} onClick={() => testConnection.mutate()}>{testConnection.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Plug size={16} />}Test connection</button>
              {testConnection.data ? <span className="success" role="status">Radarr {testConnection.data.version} connected</span> : null}
            </div>
            {testConnection.error ? <p className="error" role="alert">{testConnection.error.message}</p> : null}
          </fieldset>
        </section>
      </RadarrTabPanel>
      <RadarrTabPanel tab="mappings" active={tab}>
        <section className="radarr-section" aria-labelledby="radarr-mapping-heading">
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id="radarr-mapping-heading">Folder mappings</h2><InfoTooltip label="About folder mappings">Automatic matches full Radarr root paths against movie-type sections under SRTL's configured symlink directory. It never guesses from similar names. Use Manual when container paths differ. Title-folder names beneath the roots must still match exactly. Only mapped titles are eligible; no mounts or files are changed.</InfoTooltip></div></div>
          <p className="radarr-lede">Pairs Radarr root folders with SRTL Movies sections. Only titles under a mapped folder are synchronized.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="segmented radarr-mapping-mode" role="group" aria-labelledby="radarr-mapping-heading">
              <button type="button" className={draft.mappingMode === "auto" ? "selected" : ""} aria-pressed={draft.mappingMode === "auto"} onClick={() => update("mappingMode", "auto")}>Automatic</button>
              <button type="button" className={draft.mappingMode === "manual" ? "selected" : ""} aria-pressed={draft.mappingMode === "manual"} onClick={() => setDraft((current) => ({ ...current, mappingMode: "manual", mappings: current.mappings.length ? current.mappings : detectedMappings }))}>Manual</button>
            </div>
            {draft.mappingMode === "auto" ? <div className="radarr-auto-mappings" role="region" aria-label="Automatic folder matches">
              {detectedMappings.length ? <><p className="muted">{testConnection.data ? "Detected matches" : "Saved matches"}</p><dl>{detectedMappings.map((mapping) => <div key={mapping.rootPath}><dt>{mapping.rootPath}</dt><dd>{sections.sectionTitles?.[mapping.section] ?? mapping.section}</dd></div>)}</dl></> : <p className="muted">{testConnection.data ? "No exact folder matches found. Select Manual to map different container paths." : "Test the connection to detect matching folders."}</p>}
              {testConnection.data?.unmatchedRootFolders.length ? <div className="radarr-unmatched"><p>Unmatched Radarr roots</p><ul>{testConnection.data.unmatchedRootFolders.map((root) => <li key={root}>{root}</li>)}</ul><p className="muted">Excluded from synchronization. Use Manual to include them.</p></div> : null}
            </div> : <>
            <div className="radarr-mappings">{draft.mappings.map((mapping, index) => <div className="radarr-mapping" key={index}>
              <label>Radarr root folder<input form={settingsFormId} required list="radarr-roots" value={mapping.rootPath} onChange={(event) => update("mappings", draft.mappings.map((item, position) => position === index ? { ...item, rootPath: event.target.value } : item))} /></label>
              <label>SRTL symlink section<select form={settingsFormId} required value={mapping.section} onChange={(event) => update("mappings", draft.mappings.map((item, position) => position === index ? { ...item, section: event.target.value } : item))}><option value="">Select section</option>{configuredSections.map((section) => <option key={section} value={section}>{sections.sectionTitles?.[section] ?? section}</option>)}</select></label>
              <button type="button" className="secondary icon-only" title={`Remove mapping ${index + 1}`} onClick={() => update("mappings", draft.mappings.filter((_, position) => position !== index))}><Trash2 size={16} /></button>
            </div>)}</div>
            <datalist id="radarr-roots">{testConnection.data?.rootFolders.map((root) => <option key={root} value={root} />)}</datalist>
            <div><button type="button" className="secondary" disabled={!configuredSections.length || draft.mappings.length >= configuredSections.length} onClick={() => update("mappings", [...draft.mappings, { rootPath: "", section: configuredSections.find((section) => !draft.mappings.some((mapping) => mapping.section === section)) ?? "" }])}><Plus size={16} />Add mapping</button></div>
            </>}
            {!configuredSections.length ? <p className="muted">No Movies sections configured in Settings &gt; Library.</p> : null}
          </fieldset>
        </section>
      </RadarrTabPanel>
      <RadarrTabPanel tab="policy" active={tab}>
        <section className="radarr-section" aria-labelledby="radarr-policy-tags-heading">
          <div className="radarr-heading"><h2 id="radarr-policy-tags-heading">Policy tags</h2></div>
          <p className="radarr-lede">One Radarr tag per SRTL storage policy. SRTL adds or removes only these two tags.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><RadarrFieldLabel id="radarr-local-tag" label={`${storagePolicyLabel("location_1", locations)} policy tag`} help={`The Radarr tag for titles assigned to ${storagePolicyLabel("location_1", locations)}. It describes intended storage, not a completed copy. No tag is selected by default. Choose a lowercase tag before enabling synchronization.`} /><input form={settingsFormId} id="radarr-local-tag" required={draft.enabled} value={draft.localTag} placeholder="local" maxLength={100} pattern={"[a-z0-9][a-z0-9\\-]{0,99}"} onChange={(event) => update("localTag", event.target.value)} /></div>
              <div className="radarr-field"><RadarrFieldLabel id="radarr-remote-tag" label={`${storagePolicyLabel("location_2", locations)} policy tag`} help={`The Radarr tag for titles assigned to ${storagePolicyLabel("location_2", locations)}. Choose your own tag, such as ignored, distinct from the other policy tag. SRTL adds or removes only these two tags; unrelated tags are preserved.`} /><input form={settingsFormId} id="radarr-remote-tag" required={draft.enabled} value={draft.remoteTag} placeholder="remote" maxLength={100} pattern={"[a-z0-9][a-z0-9\\-]{0,99}"} onChange={(event) => update("remoteTag", event.target.value)} /></div>
            </div>
          </fieldset>
        </section>
        <RadarrPolicies state={state} disabled={busy} hasUnsavedChanges={hasUnsavedChanges} />
      </RadarrTabPanel>
      <RadarrTabPanel tab="monitoring" active={tab}>
        <section className="radarr-section" aria-labelledby="radarr-monitoring-heading">
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id="radarr-monitoring-heading">Copy monitoring</h2><InfoTooltip label="About copy monitoring">After a copy finishes, SRTL checks each mapped movie in it. When every file of the movie reached the destination, copying to {storagePolicyLabel("location_1", locations)} unmonitors it in Radarr and copying to {storagePolicyLabel("location_2", locations)} monitors it again. Movies with failed files are skipped. Copies started without the option never change monitoring.</InfoTooltip></div></div>
          <p className="radarr-lede">Copying a movie to {storagePolicyLabel("location_1", locations)} can unmonitor it in Radarr, and copying it to {storagePolicyLabel("location_2", locations)} monitors it again.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-option">
              <label className="radarr-toggle"><input form={settingsFormId} type="checkbox" checked={draft.monitorOnCopy} onChange={(event) => update("monitorOnCopy", event.target.checked)} />Update Radarr monitoring after copies by default</label>
              <p className="muted">Sets the starting value of the Radarr monitoring option shown beside copy buttons for mapped Movies sections. Each copy can override it.</p>
            </div>
          </fieldset>
        </section>
      </RadarrTabPanel>
      <RadarrTabPanel tab="webhooks" active={tab}>
        <section className="radarr-section" aria-labelledby="radarr-webhooks-heading">
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id="radarr-webhooks-heading">Webhooks</h2><InfoTooltip label="About webhooks">Optional. Radarr notifications queue normal title-rescan jobs after imports, upgrades, or renames. They scan the mapped title, not the whole library, and wait behind overlapping jobs. Tag synchronization and copy monitoring work without webhooks.</InfoTooltip></div></div>
          <p className="radarr-lede">Optional. Lets Radarr queue a title rescan after imports, upgrades, and renames.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><RadarrFieldLabel id="radarr-webhook-url" label="Webhook URL" help="Use this as the POST URL in Radarr Settings > Connect > Webhook. If the browser address is not reachable from Radarr, replace its host and port with the reachable SRTL address. Never put the secret in the URL." /><input id="radarr-webhook-url" readOnly value={webhookUrl} onFocus={(event) => event.target.select()} /></div>
              <div className="radarr-field"><RadarrFieldLabel id="radarr-webhook-secret" label="X-SRTL-Webhook-Secret" help="Optional; required only to accept webhooks. Enter your own 24-256 character secret using letters, numbers, hyphens, or underscores. Add the same value as a custom header in Radarr. Save it securely: SRTL cannot display it again. Leave blank to keep a saved secret." /><input form={settingsFormId} id="radarr-webhook-secret" type="password" autoComplete="new-password" minLength={24} maxLength={256} pattern={"[A-Za-z0-9_\\-]+"} value={draft.webhookSecret} placeholder={settings.hasWebhookSecret ? "Saved; leave blank to keep" : "Your secret, at least 24 characters"} onChange={(event) => update("webhookSecret", event.target.value)} /></div>
            </div>
          </fieldset>
          <details className="radarr-setup radarr-webhook-setup"><summary>Webhook setup</summary><p>In Radarr Settings &gt; Connect &gt; Webhook, use POST with the URL above. Add the custom header <code>X-SRTL-Webhook-Secret</code> with your saved secret. Select On Import, On Upgrade, and On Rename, then test and save. The URL must be reachable from Radarr.</p></details>
        </section>
      </RadarrTabPanel>
      <RadarrTabPanel tab="activity" active={tab}>
        <RadarrWebhookActivity events={state.events} onScanJobSelect={onScanJobSelect} />
        <RadarrMonitorActivity updates={state.monitorUpdates} />
      </RadarrTabPanel>
    </div>
  </div>;
}

function RadarrWebhookActivity({ events, onScanJobSelect }: { events: RadarrState["events"]; onScanJobSelect: (prompt: ScanStatusPrompt) => void }) {
  return <section className="radarr-section" aria-labelledby="radarr-webhook-activity-heading">
    <div className="radarr-heading"><h2 id="radarr-webhook-activity-heading">Webhook events</h2></div>
    <p className="radarr-lede">Recent notifications from Radarr and the title rescans they queued.</p>
    <div className="radarr-table-scroll" tabIndex={0} aria-label="Recent Radarr events">
      <table><thead><tr><th>Received</th><th>Title</th><th>Event</th><th>Status</th><th>Job</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}>
          <td className="radarr-nowrap">{formatDate(event.receivedAt)}</td><td>{event.title}</td><td>{event.eventType}</td>
          <td>{event.error ? <span className={event.processedAt ? "muted" : "error"}>{event.error}</span> : event.jobStatus?.replaceAll("_", " ") ?? (event.processedAt ? "Processed" : "Waiting")}</td>
          <td>{event.jobId ? <button type="button" className="secondary" aria-label={`View scan job #${event.jobId}`} title={`View scan job #${event.jobId}`} onClick={() => onScanJobSelect({ key: `radarr-${event.jobId}`, title: "Title rescan", description: event.title, jobId: event.jobId! })}><Eye size={16} />#{event.jobId}</button> : "-"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!events.length ? <p className="muted">No webhook events received.</p> : null}
  </section>;
}

function RadarrMonitorActivity({ updates }: { updates: RadarrState["monitorUpdates"] }) {
  return <section className="radarr-section" aria-labelledby="radarr-monitor-activity-heading">
    <div className="radarr-heading"><h2 id="radarr-monitor-activity-heading">Monitoring updates</h2></div>
    <p className="radarr-lede">Recent Radarr monitoring changes made after copies finished.</p>
    <div className="radarr-table-scroll" tabIndex={0} aria-label="Recent Radarr monitoring updates">
      <table><thead><tr><th>Queued</th><th>Title</th><th>Change</th><th>Status</th><th>Copy job</th></tr></thead>
        <tbody>{updates.map((update) => <tr key={update.id}>
          <td className="radarr-nowrap">{formatDate(update.createdAt)}</td><td>{update.title}</td><td>{update.monitored ? "Monitor" : "Unmonitor"}</td>
          <td>{update.error ? <span className={update.processedAt ? "muted" : "error"}>{update.error}</span> : update.processedAt ? "Applied" : "Waiting"}</td>
          <td>{update.copyJobId ? `#${update.copyJobId}` : "-"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!updates.length ? <p className="muted">No monitoring updates yet.</p> : null}
  </section>;
}

function RadarrPolicies({ state, disabled, hasUnsavedChanges }: { state: RadarrState; disabled: boolean; hasUnsavedChanges: boolean }) {
  const queryClient = useQueryClient();
  const locations = useStorageLocations();
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [confirmation, setConfirmation] = useState<"use_srtl" | "import_tags" | null>(null);
  const refresh = useMutation({ mutationKey: policyMutationKey, mutationFn: api.refreshRadarr, onSuccess: (data) => queryClient.setQueryData(queryKey, data) });
  const reconcile = useMutation({
    mutationKey: policyMutationKey,
    mutationFn: (action: "use_srtl" | "import_tags") => api.reconcileRadarr(selected, action),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      for (const key of ["storage-policies", "sections", "inventory-summary", "media-links", "media-links-page", "media-link-tree", "dashboard-remote-work-links", "storage-files"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      setSelected([]);
      setConfirmation(null);
    }
  });
  const busy = disabled || refresh.isPending || reconcile.isPending;
  const tagsConfigured = Boolean(state.settings.localTag && state.settings.remoteTag);
  const filtered = state.movies.filter((movie) => movie.title.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || movie.status === filter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  const selectedMovies = state.movies.filter((movie) => selected.includes(movie.movieId));
  const canImport = selectedMovies.length > 0 && selectedMovies.every((movie) => movie.section && movie.tagPolicy !== "conflict" && movie.tagPolicy !== "unassigned" && (movie.policy === "unassigned" || movie.policy === movie.tagPolicy));
  return <section className="radarr-section" aria-labelledby="radarr-policies-heading">
    <div className="radarr-heading"><div className="radarr-help-heading"><h2 id="radarr-policies-heading">Policy synchronization</h2><InfoTooltip label="About policy synchronization">While enabled, every policy you set in SRTL updates the title's Radarr tags. Titles without either policy tag follow SRTL automatically. Titles where Radarr already has the other policy tag show Needs review until you change their SRTL policy or choose an action below. Refresh preview reads Radarr without changing tags; SRTL also refreshes it every 30 minutes.</InfoTooltip></div><button className="secondary" disabled={busy || !state.settings.hasApiKey} onClick={() => refresh.mutate()}>{refresh.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <RefreshCw size={16} />}Refresh preview</button></div>
    {hasUnsavedChanges ? <p className="radarr-draft-notice">Preview and policy actions use saved settings, not your unsaved changes.</p> : null}
    <p className="muted">{state.settings.enabled ? "Active" : "Paused"}{state.settings.lastRefreshAt ? ` - Last refreshed ${formatDate(state.settings.lastRefreshAt)}` : ""}</p>
    {!tagsConfigured ? <p className="muted">Choose and save both policy tags before reconciling titles.</p> : null}
    {state.settings.lastError || refresh.error || reconcile.error ? <p className="error" role="alert">{state.settings.lastError ?? refresh.error?.message ?? reconcile.error?.message}</p> : null}
    <div className="radarr-toolbar">
      <input className="radarr-search" type="search" aria-label="Search Radarr titles" placeholder="Search titles" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
      <select aria-label="Filter synchronization status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="secondary" disabled={busy || selected.length >= selectionLimit || !visible.some((movie) => movie.section && !selected.includes(movie.movieId))} onClick={() => { setSelected((ids) => [...new Set([...ids, ...visible.filter((movie) => movie.section).map((movie) => movie.movieId)])].slice(0, selectionLimit)); setConfirmation(null); }}>Select page</button>
      <button className="secondary" disabled={busy || selected.length >= selectionLimit || !filtered.some((movie) => movie.section && !selected.includes(movie.movieId))} onClick={() => { setSelected((ids) => [...new Set([...ids, ...filtered.filter((movie) => movie.section).map((movie) => movie.movieId)])].slice(0, selectionLimit)); setConfirmation(null); }}>Select all matching</button>
      <button className="secondary" disabled={busy || !selected.length} onClick={() => { setSelected([]); setConfirmation(null); }}>Clear selection</button>
    </div>
    <div className="radarr-table-scroll" tabIndex={0} aria-label="Radarr policy preview">
      <table><thead><tr><th aria-label="Selection" /><th>Title</th><th>SRTL policy</th><th>Radarr tags</th><th>Monitored</th><th>Sync status</th></tr></thead><tbody>
        {visible.map((movie) => <tr key={movie.movieId}>
          <td><input type="checkbox" aria-label={`Select ${movie.title}`} checked={selected.includes(movie.movieId)} disabled={busy || !movie.section || (!selected.includes(movie.movieId) && selected.length >= selectionLimit)} onChange={(event) => { setSelected((ids) => event.target.checked ? [...ids, movie.movieId] : ids.filter((id) => id !== movie.movieId)); setConfirmation(null); }} /></td>
          <td><strong>{movie.title}</strong><span className="radarr-path">{movie.folderPath}</span></td>
          <td>{storagePolicyLabel(movie.policy, locations)}</td><td>{movie.tags.join(", ") || "None"}</td><td>{movie.monitored === null ? "-" : movie.monitored ? "Yes" : "No"}</td>
          <td><span className={`radarr-status radarr-status-${movie.status}`}>{statusLabels[movie.status]}</span>{movie.message ? <span className="radarr-path error">{movie.message}</span> : movie.status === "review" ? <span className="radarr-path">Radarr tag differs from the SRTL policy</span> : null}</td>
        </tr>)}
      </tbody></table>
    </div>
    {!filtered.length ? <p className="muted">{state.movies.length ? "No matching titles." : "No titles loaded."}</p> : null}
    <div className="radarr-toolbar radarr-pagination">
      <span>{selected.length} selected</span>
      <span>{filtered.length} titles - Page {currentPage + 1} of {pageCount}</span>
      <div className="radarr-pagination-controls">
        <button className="secondary icon-only" title="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button>
        <button className="secondary icon-only" title="Next page" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
    <div className="radarr-toolbar">
      <button className="secondary" disabled={busy || !tagsConfigured || !selected.length} onClick={() => setConfirmation("use_srtl")}><ArrowUpFromLine size={16} />Use SRTL policies</button>
      <button className="secondary" disabled={busy || !tagsConfigured || !canImport} title="Import only single policy tags into unassigned or matching titles" onClick={() => setConfirmation("import_tags")}><ArrowDownToLine size={16} />Import existing tags</button>
    </div>
    {confirmation ? <div className="radarr-confirmation" role="group" aria-label="Confirm policy synchronization">
      <p>{confirmation === "use_srtl" ? `Let SRTL manage tags for ${selected.length} titles? Only the ${state.settings.localTag} and ${state.settings.remoteTag} tags will be added or removed to match each SRTL policy. Unassigned titles will have neither tag.` : `Import Radarr policy tags for ${selected.length} titles? SRTL will manage these two tags after import.`} No files will be copied.{!state.settings.enabled ? " Tag updates will wait until the connection is enabled." : ""}</p>
      <div className="radarr-toolbar"><button disabled={busy} onClick={() => reconcile.mutate(confirmation)}>{reconcile.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}{reconcile.isPending ? "Applying..." : "Confirm"}</button><button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}><X size={16} />Cancel</button></div>
    </div> : null}
  </section>;
}
