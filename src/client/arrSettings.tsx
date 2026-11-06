import { createContext, useContext, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronLeft, KeyRound, ChevronRight, Eye, LoaderCircle, Pencil, Plug, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { generateWebhookSecret, type ArrConnectionTest, type ArrEventStatus, type ArrMonitorUpdateStatus, type ArrSettings, type ArrSettingsInput, type ArrSyncStatus, type ArrTitleStatus } from "../shared/arr";
import type { SectionContentType, SectionSettings } from "../shared/types";
import { api } from "./api";
import { InfoTooltip } from "./App";
import { formatDate, storagePolicyLabel, useStorageLocations, type ScanStatusPrompt } from "./appShared";
import { CopyButton } from "./copyButton";
import { ScanStatusDialog } from "./jobPresentation";
import { SettingsTabs } from "./settingsTabs";

// The Radarr and Sonarr settings pages share this UI; the service supplies its API calls and the wording that differs.
// Styles use the radarr-* classes for both.

export interface ArrUiState {
  settings: ArrSettings;
  events: ArrEventStatus[];
  monitorUpdates: ArrMonitorUpdateStatus[];
}

export interface ArrUiTitle extends ArrTitleStatus {
  id: number;
}

export interface ArrUiInstanceSummary {
  settings: ArrSettings;
  review: number;
}

export interface ArrUiOverview {
  instances: ArrUiInstanceSummary[];
  limit: number;
}

export interface ArrUiService {
  key: "radarr" | "sonarr";
  name: string;
  sectionType: SectionContentType;
  sectionTypeLabel: string;
  sectionKind: string;
  urlPlaceholder: string;
  instanceExamples: string;
  titles: (state: ArrUiState) => ArrUiTitle[];
  setupMonitoring: string;
  monitoringHelp: (local: string, remote: string) => string;
  monitoringLede: (local: string, remote: string) => string;
  webhookTriggers: string[];
  api: {
    overview: () => Promise<ArrUiOverview>;
    get: (instanceId: string) => Promise<ArrUiState>;
    create: (name: string) => Promise<ArrUiState>;
    rename: (instanceId: string, name: string) => Promise<ArrUiOverview>;
    remove: (instanceId: string) => Promise<ArrUiOverview>;
    save: (instanceId: string, body: ArrSettingsInput) => Promise<ArrUiState>;
    test: (instanceId: string, body: ArrSettingsInput) => Promise<ArrConnectionTest>;
    refresh: (instanceId: string) => Promise<ArrUiState>;
    reconcile: (instanceId: string, ids: number[], action: "use_srtl" | "import_tags") => Promise<ArrUiState>;
  };
}

const ServiceContext = createContext<ArrUiService | null>(null);

function useService(): ArrUiService {
  const service = useContext(ServiceContext);
  if (!service) throw new Error("Integration settings need a service.");
  return service;
}

const overviewKey = (service: ArrUiService) => [service.key];
const instanceKey = (service: ArrUiService, instanceId: string) => [service.key, "instance", instanceId];
const copyDefaultsKey = (service: ArrUiService) => [`${service.key}-copy-defaults`];
const policyMutationKey = (service: ArrUiService) => [service.key, "policies"];
const settingsFormId = (service: ArrUiService) => `${service.key}-settings-form`;
const selectionLimit = 1000;
const statusLabels: Record<ArrSyncStatus, string> = { unmapped: "Unmapped", review: "Needs review", pending: "Pending", synced: "Synced", error: "Retrying" };

function ArrFieldLabel({ id, label, help }: { id: string; label: string; help: string }) {
  return <div className="radarr-field-label"><label htmlFor={id}>{label}</label><InfoTooltip label={`About ${label}`}>{help}</InfoTooltip></div>;
}

const webhookHeaderName = "X-SRTL-Webhook-Secret";
const arrTabs = [
  { key: "connection", label: "Connection" },
  { key: "mappings", label: "Folder mappings" },
  { key: "policy", label: "Policy sync" },
  { key: "monitoring", label: "Copy monitoring" },
  { key: "webhooks", label: "Webhooks" },
  { key: "activity", label: "Activity" }
] as const;
type ArrTab = (typeof arrTabs)[number]["key"];

function readStoredTab(service: ArrUiService): ArrTab {
  try {
    const stored = window.localStorage.getItem(`srtl-${service.key}-settings-tab`);
    return arrTabs.find((tab) => tab.key === stored)?.key ?? "connection";
  } catch {
    return "connection";
  }
}

function readStoredInstance(service: ArrUiService): string | null {
  try {
    return window.localStorage.getItem(`srtl-${service.key}-instance`);
  } catch {
    return null;
  }
}

function storeInstance(service: ArrUiService, instanceId: string) {
  try {
    window.localStorage.setItem(`srtl-${service.key}-instance`, instanceId);
  } catch {
    // The selection still applies for this page view when storage is restricted.
  }
}

function sameMappings(left: ArrSettingsInput["mappings"], right: ArrSettingsInput["mappings"]) {
  return left.length === right.length && left.every((mapping, index) => mapping.rootPath === right[index]?.rootPath && mapping.section === right[index]?.section);
}

function unsavedTabsFor(draft: ArrSettingsInput, settings: ArrSettings): Record<ArrTab, boolean> {
  return {
    connection: draft.baseUrl !== settings.baseUrl || Boolean(draft.apiKey),
    mappings: draft.mappingMode !== settings.mappingMode || (draft.mappingMode === "manual" && !sameMappings(draft.mappings, settings.mappings)),
    policy: draft.localTag !== settings.localTag || draft.remoteTag !== settings.remoteTag,
    monitoring: draft.monitorOnCopy !== settings.monitorOnCopy,
    webhooks: Boolean(draft.webhookSecret),
    activity: false
  };
}

function hasUnsavedDraft(draft: ArrSettingsInput | undefined, settings: ArrSettings) {
  return Boolean(draft && draft.revision === settings.revision && (draft.enabled !== settings.enabled || Object.values(unsavedTabsFor(draft, settings)).some(Boolean)));
}

function UnsavedMarker() {
  return <span className="settings-tab-unsaved" title="Unsaved changes"><span className="sr-only">(unsaved changes)</span></span>;
}

export function ArrSettingsPanel({ service, active }: { service: ArrUiService; active: boolean }) {
  return <ServiceContext.Provider value={service}><ArrPanel active={active} /></ServiceContext.Provider>;
}

function ArrPanel({ active }: { active: boolean }) {
  const service = useService();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: overviewKey(service), queryFn: service.api.overview, refetchInterval: active ? 5000 : false });
  const sections = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [scanPrompt, setScanPrompt] = useState<ScanStatusPrompt | null>(null);
  const [requestedInstance, setRequestedInstance] = useState<string | null>(() => readStoredInstance(service));
  // Drafts live here so switching instances keeps each one's unsaved edits; a draft only applies to the revision it was made from.
  const [drafts, setDrafts] = useState<Record<string, ArrSettingsInput>>({});
  // Held above the configuration because saving remounts it with the new revision.
  const [tab, setTab] = useState<ArrTab>(() => readStoredTab(service));
  // Also held here: saving the secret is the first webhook step, so the steps and a generated secret must survive that remount.
  const [webhookSetups, setWebhookSetups] = useState<Record<string, WebhookSetup>>({});
  const instances = Array.isArray(overview.data?.instances) ? overview.data.instances : [];
  const selected = instances.find((instance) => instance.settings.id === requestedInstance) ?? instances[0];
  const selectedId = selected?.settings.id ?? null;
  const state = useQuery({ queryKey: instanceKey(service, selectedId ?? ""), queryFn: () => service.api.get(selectedId!), enabled: Boolean(selectedId), refetchInterval: active ? 5000 : false });
  const selectTab = (next: ArrTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(`srtl-${service.key}-settings-tab`, next);
    } catch {
      // The selected tab still applies for this page view when storage is restricted.
    }
  };
  const selectInstance = (instanceId: string) => {
    setRequestedInstance(instanceId);
    storeInstance(service, instanceId);
  };
  const forgetInstance = (instanceId: string) => {
    setDrafts(({ [instanceId]: _removed, ...rest }) => rest);
    setWebhookSetups(({ [instanceId]: _removed, ...rest }) => rest);
    queryClient.removeQueries({ queryKey: instanceKey(service, instanceId) });
  };
  if (overview.isLoading || sections.isLoading) return <p role="status">Loading integrations...</p>;
  if (!overview.data || !Array.isArray(overview.data.instances) || !sections.data) return <p className="error" role="alert">{overview.error?.message ?? sections.error?.message ?? "Integration settings unavailable."}</p>;
  const current = state.data && state.data.settings.id === selectedId ? state.data : null;
  return <div className="radarr-settings">
    {overview.error ? <p className="error" role="alert">{overview.error.message}</p> : null}
    <ArrInstanceList overview={{ ...overview.data, instances }} sections={sections.data} selectedId={selectedId} drafts={drafts} onSelect={selectInstance} onCreated={(created) => { selectInstance(created.settings.id); selectTab("connection"); }} />
    {selected && current ? <>
      {state.error ? <p className="error" role="alert">{state.error.message}</p> : null}
      <ArrConfiguration
        key={`${current.settings.id}:${current.settings.revision}`}
        state={current}
        instances={instances}
        sections={sections.data}
        draft={drafts[current.settings.id]?.revision === current.settings.revision ? drafts[current.settings.id]! : null}
        onDraftChange={(draft) => setDrafts((all) => ({ ...all, [current.settings.id]: draft }))}
        onSaved={() => setDrafts(({ [current.settings.id]: _saved, ...rest }) => rest)}
        onRemoved={(next) => { forgetInstance(current.settings.id); const remaining = next.instances[0]?.settings.id; if (remaining) selectInstance(remaining); }}
        tab={tab}
        onTabSelect={selectTab}
        onScanJobSelect={setScanPrompt}
        webhookSetup={webhookSetups[current.settings.id] ?? {}}
        onWebhookSetupChange={(change) => setWebhookSetups((all) => ({ ...all, [current.settings.id]: { ...all[current.settings.id], ...change } }))}
      />
    </> : selected ? state.error ? <p className="error" role="alert">{state.error.message}</p> : <p role="status">Loading {selected.settings.name}...</p> : null}
    <ScanStatusDialog prompt={scanPrompt} onClose={() => setScanPrompt(null)} />
  </div>;
}

function instanceStatus(summary: ArrUiInstanceSummary): { label: string; kind: "enabled" | "paused" | "error" | "new" } {
  const { settings } = summary;
  if (settings.lastError) return { label: "Error", kind: "error" };
  if (settings.enabled) return { label: "Enabled", kind: "enabled" };
  return settings.hasApiKey ? { label: "Paused", kind: "paused" } : { label: "Not connected", kind: "new" };
}

function ArrInstanceList({ overview, sections, selectedId, drafts, onSelect, onCreated }: { overview: ArrUiOverview; sections: SectionSettings; selectedId: string | null; drafts: Record<string, ArrSettingsInput>; onSelect: (instanceId: string) => void; onCreated: (state: ArrUiState) => void }) {
  const service = useService();
  const { key, name: serviceName } = service;
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => service.api.create(name.trim()),
    onSuccess: (state) => {
      queryClient.setQueryData(instanceKey(service, state.settings.id), state);
      void queryClient.invalidateQueries({ queryKey: overviewKey(service), exact: true });
      setAdding(false);
      setName("");
      onCreated(state);
    }
  });
  const atLimit = overview.instances.length >= overview.limit;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!create.isPending) create.mutate(); };
  return <section className="radarr-instances" aria-labelledby={`${key}-instances-heading`}>
    <div className="radarr-heading">
      <div className="radarr-help-heading"><h2 id={`${key}-instances-heading`}><Plug size={18} />{serviceName} instances</h2><InfoTooltip label={`About ${serviceName} instances`}>Connect each {serviceName} you run, such as {service.instanceExamples}. Every instance has its own connection, policy tags, and webhook, and owns the SRTL folders mapped to it. A folder can belong to only one instance. Storage policies belong to titles, so every instance holding a title tags it the same way.</InfoTooltip></div>
      <button type="button" className="secondary" disabled={atLimit || adding} title={atLimit ? `Up to ${overview.limit} instances are supported` : undefined} onClick={() => { setAdding(true); create.reset(); }}><Plus size={16} />Add instance</button>
    </div>
    {adding ? <form className="radarr-instance-form" aria-label={`Add ${serviceName} instance`} onSubmit={submit}>
      <label htmlFor={`${key}-new-instance-name`}>Instance name</label>
      <div className="radarr-toolbar">
        <input id={`${key}-new-instance-name`} required maxLength={60} autoFocus value={name} placeholder={`${serviceName} 4K`} onChange={(event) => setName(event.target.value)} />
        <button type="submit" disabled={create.isPending || !name.trim()}>{create.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}Add</button>
        <button type="button" className="secondary" disabled={create.isPending} onClick={() => { setAdding(false); setName(""); }}><X size={16} />Cancel</button>
      </div>
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
    </form> : null}
    {overview.instances.length ? <ul className="radarr-instance-list">
      {overview.instances.map((summary) => {
        const { settings } = summary;
        const status = instanceStatus(summary);
        const folders = settings.mappings.map((mapping) => sections.sectionTitles?.[mapping.section] ?? mapping.section);
        const unsaved = hasUnsavedDraft(drafts[settings.id], settings);
        return <li key={settings.id}>
          <button type="button" className="radarr-instance" aria-current={settings.id === selectedId ? "true" : undefined} onClick={() => onSelect(settings.id)}>
            <span className="radarr-instance-title"><span className="radarr-instance-name" title={settings.name}>{settings.name}</span>{unsaved ? <UnsavedMarker /> : null}<span className={`radarr-instance-status radarr-instance-status-${status.kind}`}>{status.label}</span></span>
            <span className="radarr-instance-detail">{folders.length ? folders.join(", ") : "No folders mapped"}</span>
            <span className={`radarr-instance-detail${settings.lastError ? " error" : ""}`}>{settings.lastError ?? (settings.lastRefreshAt ? `Synced ${formatDate(settings.lastRefreshAt)}` : "Not synced yet")}{!settings.lastError && summary.review ? ` - ${summary.review} need review` : ""}</span>
          </button>
        </li>;
      })}
    </ul> : <p className="muted">No {serviceName} instances yet. Add one for each {serviceName} you run, such as 1080p, 4K, or anime.</p>}
    {atLimit ? <p className="muted">SRTL supports up to {overview.limit} {serviceName} instances.</p> : null}
  </section>;
}

function ArrTabPanel({ tab, active, children }: { tab: ArrTab; active: ArrTab; children: ReactNode }) {
  const { key } = useService();
  return <div role="tabpanel" id={`${key}-panel-${tab}`} aria-labelledby={`${key}-tab-${tab}`} data-tab={tab} hidden={tab !== active} className="radarr-tab-panel">{children}</div>;
}

function ArrConfiguration({ state, instances, sections, draft: savedDraft, onDraftChange, onSaved, onRemoved, tab, onTabSelect, onScanJobSelect, webhookSetup, onWebhookSetupChange }: { state: ArrUiState; instances: ArrUiInstanceSummary[]; sections: SectionSettings; draft: ArrSettingsInput | null; onDraftChange: (draft: ArrSettingsInput) => void; onSaved: () => void; onRemoved: (overview: ArrUiOverview) => void; tab: ArrTab; onTabSelect: (tab: ArrTab) => void; onScanJobSelect: (prompt: ScanStatusPrompt) => void; webhookSetup: WebhookSetup; onWebhookSetupChange: (change: WebhookSetup) => void }) {
  const { settings } = state;
  const service = useService();
  const { key, name: serviceName } = service;
  const formId = settingsFormId(service);
  const queryClient = useQueryClient();
  const locations = useStorageLocations();
  const policyBusy = useIsMutating({ mutationKey: policyMutationKey(service) }) > 0;
  const formRef = useRef<HTMLFormElement>(null);
  const draft: ArrSettingsInput = savedDraft ?? { ...settings, apiKey: "", webhookSecret: "" };
  const setDraft = (change: (current: ArrSettingsInput) => ArrSettingsInput) => onDraftChange(change(draft));
  const update = <K extends keyof ArrSettingsInput>(key: K, value: ArrSettingsInput[K]) => {
    if (key === "baseUrl" || key === "apiKey") testConnection.reset();
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const input = { ...draft, mappings: draft.mappingMode === "auto" ? settings.mappings : draft.mappings };
  const testConnection = useMutation({ mutationFn: () => service.api.test(settings.id, { ...input, enabled: false }) });
  const save = useMutation({ mutationFn: () => service.api.save(settings.id, input), onSuccess: (state) => {
    // Saving the secret is step 1 of the webhook setup, so keep the steps as they are rather than collapsing them now that a secret exists.
    if (input.webhookSecret) onWebhookSetupChange({ open: webhookSetupOpen, ...(input.webhookSecret === webhookSetup.generatedSecret ? { generatedSaved: true } : { generatedSecret: undefined, generatedSaved: false }) });
    onSaved();
    queryClient.setQueryData(instanceKey(service, settings.id), state);
    void queryClient.invalidateQueries({ queryKey: overviewKey(service), exact: true });
    void queryClient.invalidateQueries({ queryKey: copyDefaultsKey(service) });
  } });
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useMutation({ mutationFn: (name: string) => service.api.rename(settings.id, name), onSuccess: (overview) => {
    queryClient.setQueryData(overviewKey(service), overview);
    void queryClient.invalidateQueries({ queryKey: instanceKey(service, settings.id) });
    void queryClient.invalidateQueries({ queryKey: copyDefaultsKey(service) });
    setRenaming(null);
  } });
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Shown until this page is left, also after saving: SRTL stores only a hash, so this is the one chance to copy it into Radarr or Sonarr.
  const { generatedSecret, generatedSaved = false } = webhookSetup;
  const webhookSetupOpen = webhookSetup.open ?? !settings.hasWebhookSecret;
  const showGeneratedSecret = generatedSecret !== undefined && (generatedSaved ? !draft.webhookSecret : draft.webhookSecret === generatedSecret);
  const generateSecret = () => {
    const secret = generateWebhookSecret();
    onWebhookSetupChange({ generatedSecret: secret, generatedSaved: false });
    update("webhookSecret", secret);
  };
  const remove = useMutation({ mutationFn: () => service.api.remove(settings.id), onSuccess: (overview) => {
    queryClient.setQueryData(overviewKey(service), overview);
    void queryClient.invalidateQueries({ queryKey: copyDefaultsKey(service) });
    onRemoved(overview);
  } });
  const busy = save.isPending || testConnection.isPending || rename.isPending || remove.isPending;
  const fieldsDisabled = busy || policyBusy;
  const unsavedTabs = unsavedTabsFor(draft, settings);
  const hasUnsavedChanges = draft.enabled !== settings.enabled || Object.values(unsavedTabs).some(Boolean);
  const tabs = arrTabs.map(({ key, label }) => ({ key, label: <>{label}{unsavedTabs[key] ? <UnsavedMarker /> : null}</> }));
  const configuredSections = sections.sections.filter((section) => sections.sectionTypes?.[section] === service.sectionType);
  // Folders mapped by other instances cannot be mapped here.
  const owners = new Map(instances.filter((instance) => instance.settings.id !== settings.id).flatMap((instance) => instance.settings.mappings.map((mapping) => [mapping.section, instance.settings.name] as const)));
  const availableSections = configuredSections.filter((section) => !owners.has(section));
  const sectionTitle = (section: string) => sections.sectionTitles?.[section] ?? section;
  const detectedMappings = testConnection.data?.automaticMappings ?? (settings.mappingMode === "auto" && draft.baseUrl === settings.baseUrl && !draft.apiKey ? settings.mappings : []);
  const webhookPath = `/api/integrations/${key}/${settings.id}/webhook`;
  const webhookUrl = `${window.location.origin}${webhookPath}`;
  const revealInvalidField = (event: MouseEvent<HTMLButtonElement>) => {
    const field = Array.from(formRef.current?.elements ?? []).find((element): element is HTMLInputElement | HTMLSelectElement => (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) && element.willValidate && !element.validity.valid);
    const panel = field?.closest<HTMLElement>('[role="tabpanel"]');
    // Fields on hidden tabs still belong to the form, but the browser cannot point at one it cannot show.
    if (!field || !panel?.hidden || !panel.dataset.tab) return;
    event.preventDefault();
    flushSync(() => onTabSelect(panel.dataset.tab as ArrTab));
    field.focus();
    field.reportValidity();
  };
  return <div className="radarr-instance-settings">
    {/* Only configuration controls belong to this form; policy actions remain independent. */}
    <form ref={formRef} id={formId} hidden onSubmit={(event) => { event.preventDefault(); if (!fieldsDisabled) save.mutate(); }} />
    <header className="radarr-integration-header">
      <div className="radarr-heading">
        {renaming !== null ? <form className="radarr-rename" aria-label={`Rename ${settings.name}`} onSubmit={(event) => { event.preventDefault(); if (!busy) rename.mutate(renaming.trim()); }}>
          <label className="sr-only" htmlFor={`${key}-instance-name`}>Instance name</label>
          <input id={`${key}-instance-name`} required maxLength={60} autoFocus value={renaming} onChange={(event) => setRenaming(event.target.value)} />
          <button type="submit" disabled={busy || !renaming.trim()}>{rename.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}Save name</button>
          <button type="button" className="secondary" disabled={rename.isPending} onClick={() => { setRenaming(null); rename.reset(); }}><X size={16} />Cancel</button>
        </form> : <div className="radarr-heading-identity">
          <h2><Plug size={18} />{settings.name}</h2>
          <span className="radarr-state">Current: {settings.enabled ? "Enabled" : settings.hasApiKey ? "Paused" : "Not connected"}</span>
          <button type="button" className="secondary icon-only" title={`Rename ${settings.name}`} aria-label={`Rename ${settings.name}`} disabled={busy} onClick={() => { setRenaming(settings.name); setConfirmRemove(false); }}><Pencil size={16} /></button>
          <button type="button" className="secondary icon-only" title={`Remove ${settings.name}`} aria-label={`Remove ${settings.name}`} disabled={busy} onClick={() => { setConfirmRemove(true); setRenaming(null); }}><Trash2 size={16} /></button>
        </div>}
        <div className="radarr-save-area">
          <span className={`radarr-save-status${hasUnsavedChanges && !save.isPending ? " radarr-save-status-unsaved" : ""}`} role="status">{save.isPending ? "Saving settings..." : hasUnsavedChanges ? "Unsaved changes" : settings.hasApiKey ? "No unsaved changes" : "Not configured"}</span>
          <button type="submit" form={formId} disabled={fieldsDisabled} onClick={revealInvalidField}>{save.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Save size={16} />}Save {settings.name} settings</button>
        </div>
      </div>
      {rename.error ? <p className="error" role="alert">{rename.error.message}</p> : null}
      {confirmRemove ? <div className="radarr-confirmation" role="group" aria-label={`Confirm removing ${settings.name}`}>
        <p>Remove {settings.name}? SRTL forgets its connection, folder mappings, preview, and activity, and stops updating it. Tags and monitoring in {serviceName} stay exactly as they are. Its folders become free for another instance.</p>
        <div className="radarr-toolbar"><button type="button" className="danger" disabled={busy} onClick={() => remove.mutate()}>{remove.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Trash2 size={16} />}Remove instance</button><button type="button" className="secondary" disabled={remove.isPending} onClick={() => { setConfirmRemove(false); remove.reset(); }}><X size={16} />Cancel</button></div>
        {remove.error ? <p className="error" role="alert">{remove.error.message}</p> : null}
      </div> : null}
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <div className="radarr-help-heading radarr-enable"><label className="radarr-toggle"><input form={formId} type="checkbox" disabled={fieldsDisabled} checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />Enable integration</label><InfoTooltip label="About enabling integration">Off by default. Save this instance's settings to apply this change. Enabling keeps its two policy tags in {serviceName} matched to SRTL policies, applies copy monitoring updates, and processes webhooks when a secret is saved. Pausing stops future processing, but does not terminate scan jobs already queued.</InfoTooltip></div>
      <details className="radarr-setup">
        <summary>Setup guide and requirements</summary>
        <ol>
          <li><strong>Connect:</strong> enter a URL reachable from the SRTL API and worker, plus the API key from {serviceName} Settings &gt; General &gt; Security. These are required to test or save a paused connection.</li>
          <li><strong>Prepare synchronization:</strong> Automatic mapping detects identical root paths when you test or save, skipping folders another instance already maps. Review the matches, or select Manual if container paths differ. At least one mapping and two distinct policy tags are required before enabling. Tag placeholders are examples, not active settings.</li>
          <li><strong>Enable:</strong> titles without either policy tag are tagged from their SRTL policy right away. Titles that already carry the other policy tag wait in Needs review: change their policy in SRTL, or select them and choose Use SRTL policies or Import existing tags. Every policy you set afterward updates {serviceName}. Other tags are never removed, and no files are copied.</li>
          <li><strong>Choose copy monitoring:</strong> {service.setupMonitoring} Pick the default here; each copy can override it.</li>
          <li><strong>Optional notifications:</strong> to rescan titles after {serviceName} imports, follow the Webhook setup steps in the <button type="button" className="link-button" onClick={() => onTabSelect("webhooks")}>Webhooks tab</button>.</li>
        </ol>
      </details>
    </header>
    <div className="radarr-tabs-area">
      <SettingsTabs label={`${serviceName} settings`} idPrefix={key} className="radarr-tabs" tabs={tabs} active={tab} onSelect={onTabSelect} />
      <ArrTabPanel tab="connection" active={tab}>
        <section className="radarr-section" aria-labelledby={`${key}-connection-heading`}>
          <div className="radarr-heading"><h2 id={`${key}-connection-heading`}>Connection</h2></div>
          <p className="radarr-lede">Where SRTL reaches {serviceName}. Test the connection before saving.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><ArrFieldLabel id={`${key}-url`} label={`${serviceName} URL`} help={`Required. Use the address reachable from both SRTL services, including any ${serviceName} URL base. In Docker, localhost means that container, not the host. Prefer HTTPS or a trusted private network.`} /><input form={formId} id={`${key}-url`} type="url" required value={draft.baseUrl} placeholder={service.urlPlaceholder} onChange={(event) => update("baseUrl", event.target.value)} /></div>
              <div className="radarr-field"><ArrFieldLabel id={`${key}-api-key`} label="API key" help={`Required for the first connection. Find it in ${serviceName} Settings > General > Security. Saved keys are hidden; leave this blank to keep the saved key. Changing the URL requires re-entering the key.`} /><input form={formId} id={`${key}-api-key`} type="password" autoComplete="new-password" required={!settings.hasApiKey || draft.baseUrl !== settings.baseUrl} value={draft.apiKey} placeholder={settings.hasApiKey ? "Saved; leave blank to keep" : `${serviceName} API key`} onChange={(event) => update("apiKey", event.target.value)} /></div>
            </div>
            <div className="radarr-toolbar">
              <button type="button" className="secondary" disabled={!draft.baseUrl || (!draft.apiKey && !settings.hasApiKey)} onClick={() => testConnection.mutate()}>{testConnection.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Plug size={16} />}Test connection</button>
              {testConnection.data ? <span className="success" role="status">{serviceName} {testConnection.data.version} connected</span> : null}
            </div>
            {testConnection.error ? <p className="error" role="alert">{testConnection.error.message}</p> : null}
          </fieldset>
        </section>
      </ArrTabPanel>
      <ArrTabPanel tab="mappings" active={tab}>
        <section className="radarr-section" aria-labelledby={`${key}-mapping-heading`}>
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id={`${key}-mapping-heading`}>Folder mappings</h2><InfoTooltip label="About folder mappings">Automatic matches full {serviceName} root paths against {service.sectionKind} sections under SRTL's configured symlink directory. It never guesses from similar names. Use Manual when container paths differ. Title-folder names beneath the roots must still match exactly. Only mapped titles are eligible; no mounts or files are changed.</InfoTooltip></div></div>
          <p className="radarr-lede">Pairs this instance's {serviceName} root folders with SRTL {service.sectionTypeLabel} sections. Only titles under a mapped folder are synchronized.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="segmented radarr-mapping-mode" role="group" aria-labelledby={`${key}-mapping-heading`}>
              <button type="button" className={draft.mappingMode === "auto" ? "selected" : ""} aria-pressed={draft.mappingMode === "auto"} onClick={() => update("mappingMode", "auto")}>Automatic</button>
              <button type="button" className={draft.mappingMode === "manual" ? "selected" : ""} aria-pressed={draft.mappingMode === "manual"} onClick={() => setDraft((current) => ({ ...current, mappingMode: "manual", mappings: current.mappings.length ? current.mappings : detectedMappings }))}>Manual</button>
            </div>
            {draft.mappingMode === "auto" ? <div className="radarr-auto-mappings" role="region" aria-label="Automatic folder matches">
              {detectedMappings.length ? <><p className="muted">{testConnection.data ? "Detected matches" : "Saved matches"}</p><dl>{detectedMappings.map((mapping) => <div key={mapping.rootPath}><dt>{mapping.rootPath}</dt><dd>{sections.sectionTitles?.[mapping.section] ?? mapping.section}</dd></div>)}</dl></> : <p className="muted">{testConnection.data ? "No exact folder matches found. Select Manual to map different container paths." : "Test the connection to detect matching folders."}</p>}
              {testConnection.data?.conflictingRootFolders.length ? <div className="radarr-unmatched"><p>Folders mapped by another instance</p><ul>{testConnection.data.conflictingRootFolders.map((conflict) => <li key={conflict.rootPath}>{conflict.rootPath}: {sectionTitle(conflict.section)} belongs to {conflict.instanceName}</li>)}</ul><p className="muted">Excluded here. Each folder belongs to one instance; remove it from the other instance first to map it here.</p></div> : null}
              {testConnection.data?.unmatchedRootFolders.length ? <div className="radarr-unmatched"><p>Unmatched {serviceName} roots</p><ul>{testConnection.data.unmatchedRootFolders.map((root) => <li key={root}>{root}</li>)}</ul><p className="muted">Excluded from synchronization. Use Manual to include them.</p></div> : null}
            </div> : <>
            <div className="radarr-mappings">{draft.mappings.map((mapping, index) => <div className="radarr-mapping" key={index}>
              <label>{serviceName} root folder<input form={formId} required list={`${key}-roots`} value={mapping.rootPath} onChange={(event) => update("mappings", draft.mappings.map((item, position) => position === index ? { ...item, rootPath: event.target.value } : item))} /></label>
              <label>SRTL symlink section<select form={formId} required value={mapping.section} onChange={(event) => update("mappings", draft.mappings.map((item, position) => position === index ? { ...item, section: event.target.value } : item))}><option value="">Select section</option>{configuredSections.map((section) => <option key={section} value={section} disabled={owners.has(section)}>{sectionTitle(section)}{owners.has(section) ? ` (mapped by ${owners.get(section)})` : ""}</option>)}</select></label>
              <button type="button" className="secondary icon-only" title={`Remove mapping ${index + 1}`} onClick={() => update("mappings", draft.mappings.filter((_, position) => position !== index))}><Trash2 size={16} /></button>
            </div>)}</div>
            <datalist id={`${key}-roots`}>{testConnection.data?.rootFolders.map((root) => <option key={root} value={root} />)}</datalist>
            <div><button type="button" className="secondary" disabled={!availableSections.length || draft.mappings.length >= availableSections.length} onClick={() => update("mappings", [...draft.mappings, { rootPath: "", section: availableSections.find((section) => !draft.mappings.some((mapping) => mapping.section === section)) ?? "" }])}><Plus size={16} />Add mapping</button></div>
            </>}
            {!configuredSections.length ? <p className="muted">No {service.sectionTypeLabel} sections configured in Settings &gt; Library.</p> : null}
            {owners.size ? <p className="muted">Mapped by other instances: {[...owners].map(([section, name]) => `${sectionTitle(section)} (${name})`).join(", ")}. Each folder belongs to one instance.</p> : null}
          </fieldset>
        </section>
      </ArrTabPanel>
      <ArrTabPanel tab="policy" active={tab}>
        <section className="radarr-section" aria-labelledby={`${key}-policy-tags-heading`}>
          <div className="radarr-heading"><h2 id={`${key}-policy-tags-heading`}>Policy tags</h2></div>
          <p className="radarr-lede">One {serviceName} tag per SRTL storage policy. SRTL adds or removes only these two tags.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><ArrFieldLabel id={`${key}-local-tag`} label={`${storagePolicyLabel("location_1", locations)} policy tag`} help={`The ${serviceName} tag for titles assigned to ${storagePolicyLabel("location_1", locations)}. It describes intended storage, not a completed copy. No tag is selected by default. Choose a lowercase tag before enabling synchronization.`} /><input form={formId} id={`${key}-local-tag`} required={draft.enabled} value={draft.localTag} placeholder="local" maxLength={100} pattern={"[a-z0-9][a-z0-9\\-]{0,99}"} onChange={(event) => update("localTag", event.target.value)} /></div>
              <div className="radarr-field"><ArrFieldLabel id={`${key}-remote-tag`} label={`${storagePolicyLabel("location_2", locations)} policy tag`} help={`The ${serviceName} tag for titles assigned to ${storagePolicyLabel("location_2", locations)}. Choose your own tag, such as ignored, distinct from the other policy tag. SRTL adds or removes only these two tags; unrelated tags are preserved.`} /><input form={formId} id={`${key}-remote-tag`} required={draft.enabled} value={draft.remoteTag} placeholder="remote" maxLength={100} pattern={"[a-z0-9][a-z0-9\\-]{0,99}"} onChange={(event) => update("remoteTag", event.target.value)} /></div>
            </div>
          </fieldset>
        </section>
        <ArrPolicies state={state} disabled={busy} hasUnsavedChanges={hasUnsavedChanges} />
      </ArrTabPanel>
      <ArrTabPanel tab="monitoring" active={tab}>
        <section className="radarr-section" aria-labelledby={`${key}-monitoring-heading`}>
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id={`${key}-monitoring-heading`}>Copy monitoring</h2><InfoTooltip label="About copy monitoring">{service.monitoringHelp(storagePolicyLabel("location_1", locations), storagePolicyLabel("location_2", locations))}</InfoTooltip></div></div>
          <p className="radarr-lede">{service.monitoringLede(storagePolicyLabel("location_1", locations), storagePolicyLabel("location_2", locations))}</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-option">
              <label className="radarr-toggle"><input form={formId} type="checkbox" checked={draft.monitorOnCopy} onChange={(event) => update("monitorOnCopy", event.target.checked)} />Update {serviceName} monitoring after copies by default</label>
              <p className="muted">Sets the starting value of the {serviceName} monitoring option shown beside copy buttons for mapped {service.sectionTypeLabel} sections. Each copy can override it.</p>
            </div>
          </fieldset>
        </section>
      </ArrTabPanel>
      <ArrTabPanel tab="webhooks" active={tab}>
        <section className="radarr-section" aria-labelledby={`${key}-webhooks-heading`}>
          <div className="radarr-heading"><div className="radarr-help-heading"><h2 id={`${key}-webhooks-heading`}>Webhooks</h2><InfoTooltip label="About webhooks">Optional. {serviceName} notifications queue normal title-rescan jobs after imports, upgrades, or renames. They scan the mapped title, not the whole library, and wait behind overlapping jobs. Tag synchronization and copy monitoring work without webhooks.</InfoTooltip></div></div>
          <p className="radarr-lede">Optional. Lets {serviceName} queue a title rescan after imports, upgrades, and renames.</p>
          <fieldset disabled={fieldsDisabled} className="radarr-fields">
            <div className="radarr-grid">
              <div className="radarr-field"><ArrFieldLabel id={`${key}-webhook-secret`} label="Header value (secret)" help={`Optional; required only to accept webhooks. Enter your own 24-256 character secret using letters, numbers, hyphens, or underscores, or generate one. Use it as the value of the ${webhookHeaderName} header in ${serviceName}. Save it securely: SRTL cannot display it again. Leave blank to keep a saved secret.`} /><input form={formId} id={`${key}-webhook-secret`} type="password" autoComplete="new-password" minLength={24} maxLength={256} pattern={"[A-Za-z0-9_\\-]+"} value={draft.webhookSecret} placeholder={settings.hasWebhookSecret ? "Saved; leave blank to keep" : "Your secret, at least 24 characters"} onChange={(event) => update("webhookSecret", event.target.value)} /><div className="radarr-toolbar"><button type="button" className="secondary" onClick={generateSecret}><KeyRound size={16} />{settings.hasWebhookSecret || showGeneratedSecret ? "Generate new secret" : "Generate secret"}</button></div></div>
            </div>
            {showGeneratedSecret ? <div className="radarr-generated-secret" role="group" aria-label="Generated webhook secret">
              <label htmlFor={`${key}-generated-secret`}>Generated secret</label>
              <div className="radarr-input-action">
                <input id={`${key}-generated-secret`} readOnly value={generatedSecret} spellCheck={false} onFocus={(event) => event.target.select()} />
                <CopyButton text={generatedSecret} fallbackInputId={`${key}-generated-secret`} />
              </div>
              {generatedSaved ? <p className="muted">Saved. Copy it into {serviceName} as the {webhookHeaderName} header value: SRTL only stores a hash and can't show it again after you leave this page.</p> : <p className="muted">Copy it, then save: SRTL only stores a hash and can't show it again after you leave this page.{settings.hasWebhookSecret ? ` Saving replaces the current secret, so ${serviceName} must be updated with this new value.` : ""} {serviceName}'s Test fails until it is saved.</p>}
            </div> : null}
          </fieldset>
          <ArrWebhookSteps
            open={webhookSetupOpen}
            onToggle={(open) => onWebhookSetupChange({ open })}
            instanceName={settings.name}
            secretSaved={settings.hasWebhookSecret}
            webhookUrl={webhookUrl}
            legacyWebhook={settings.legacyWebhook}
            secret={showGeneratedSecret ? generatedSecret : undefined}
            onActivitySelect={() => onTabSelect("activity")}
          />
        </section>
      </ArrTabPanel>
      <ArrTabPanel tab="activity" active={tab}>
        <ArrWebhookActivity events={state.events} onScanJobSelect={onScanJobSelect} />
        <ArrMonitorActivity updates={state.monitorUpdates} />
      </ArrTabPanel>
    </div>
  </div>;
}

type WebhookSetup = { open?: boolean; generatedSecret?: string; generatedSaved?: boolean };

function ArrCopyField({ id, label, value }: { id: string; label: string; value: string }) {
  return <div className="radarr-step-field"><label htmlFor={id}>{label}</label><div className="radarr-input-action"><input id={id} readOnly value={value} spellCheck={false} onFocus={(event) => event.target.select()} /><CopyButton text={value} fallbackInputId={id} /></div></div>;
}

function ArrWebhookSteps({ open, onToggle, instanceName, secretSaved, webhookUrl, legacyWebhook, secret, onActivitySelect }: { open: boolean; onToggle: (open: boolean) => void; instanceName: string; secretSaved: boolean; webhookUrl: string; legacyWebhook: boolean; secret: string | undefined; onActivitySelect: () => void }) {
  const { key, name: serviceName, webhookTriggers } = useService();
  return <details className="radarr-setup radarr-webhook-setup" open={open} onToggle={(event) => { if (event.currentTarget.open !== open) onToggle(event.currentTarget.open); }}>
    <summary>Webhook setup</summary>
    <ol className="radarr-webhook-steps">
      <li><strong>In SRTL:</strong> choose Generate secret above (or enter your own), copy it, then choose Save {instanceName} settings. Save first: {serviceName}'s Test is rejected until SRTL has the secret. <span className={secretSaved ? "success" : "muted"}>{secretSaved ? "A secret is saved." : "No secret saved yet."}</span></li>
      <li><strong>In {serviceName}:</strong> open Settings &gt; Connect, choose +, then Webhook. Name it SRTL.</li>
      <li>
        Turn on exactly these triggers and leave all others off. SRTL rejects event types it doesn't handle.
        <ul className="radarr-trigger-list">{webhookTriggers.map((trigger) => <li key={trigger}>{trigger}</li>)}</ul>
      </li>
      <li>
        <ArrCopyField id={`${key}-webhook-url`} label="Webhook URL" value={webhookUrl} />
        Method: POST. Leave Username and Password empty. If {serviceName} can't reach this address, use SRTL's address as {serviceName} sees it, with the same path.
        {legacyWebhook ? <p className="muted">The original URL ending in /api/integrations/{key}/webhook keeps working for this instance.</p> : null}
      </li>
      <li>
        Under Headers (choose Show Advanced if they're hidden), add one header:
        <div className="radarr-step-fields">
          <ArrCopyField id={`${key}-webhook-header`} label="Key" value={webhookHeaderName} />
          {secret ? <ArrCopyField id={`${key}-webhook-header-value`} label="Value" value={secret} /> : <p className="radarr-step-note"><strong>Value:</strong> the secret you saved in step 1. SRTL can't show a saved secret again; if you no longer have it, generate a new one and save it.</p>}
        </div>
      </li>
      <li>Choose Test; it should pass. Then choose Save. If Test fails, check that the secret is saved in SRTL and the URL is reachable from {serviceName}.</li>
      <li>To confirm it works: after the next import, the <button type="button" className="link-button" onClick={onActivitySelect}>Activity tab</button> shows the webhook event and a title rescan job.</li>
    </ol>
  </details>;
}

function ArrWebhookActivity({ events, onScanJobSelect }: { events: ArrUiState["events"]; onScanJobSelect: (prompt: ScanStatusPrompt) => void }) {
  const { key, name: serviceName } = useService();
  return <section className="radarr-section" aria-labelledby={`${key}-webhook-activity-heading`}>
    <div className="radarr-heading"><h2 id={`${key}-webhook-activity-heading`}>Webhook events</h2></div>
    <p className="radarr-lede">Recent notifications from {serviceName} and the title rescans they queued.</p>
    <div className="radarr-table-scroll" tabIndex={0} aria-label={`Recent ${serviceName} events`}>
      <table><thead><tr><th>Received</th><th>Title</th><th>Event</th><th>Status</th><th>Job</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}>
          <td className="radarr-nowrap">{formatDate(event.receivedAt)}</td><td>{event.title}</td><td>{event.eventType}</td>
          <td>{event.error ? <span className={event.processedAt ? "muted" : "error"}>{event.error}</span> : event.jobStatus?.replaceAll("_", " ") ?? (event.processedAt ? "Processed" : "Waiting")}</td>
          <td>{event.jobId ? <button type="button" className="secondary" aria-label={`View scan job #${event.jobId}`} title={`View scan job #${event.jobId}`} onClick={() => onScanJobSelect({ key: `${key}-${event.jobId}`, title: "Title rescan", description: event.title, jobId: event.jobId! })}><Eye size={16} />#{event.jobId}</button> : "-"}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {!events.length ? <p className="muted">No webhook events received.</p> : null}
  </section>;
}

function ArrMonitorActivity({ updates }: { updates: ArrUiState["monitorUpdates"] }) {
  const { key, name: serviceName } = useService();
  return <section className="radarr-section" aria-labelledby={`${key}-monitor-activity-heading`}>
    <div className="radarr-heading"><h2 id={`${key}-monitor-activity-heading`}>Monitoring updates</h2></div>
    <p className="radarr-lede">Recent {serviceName} monitoring changes made after copies finished and when deleted files were re-requested.</p>
    <div className="radarr-table-scroll" tabIndex={0} aria-label={`Recent ${serviceName} monitoring updates`}>
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

function ArrPolicies({ state, disabled, hasUnsavedChanges }: { state: ArrUiState; disabled: boolean; hasUnsavedChanges: boolean }) {
  const service = useService();
  const { key, name: serviceName } = service;
  const queryClient = useQueryClient();
  const locations = useStorageLocations();
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [confirmation, setConfirmation] = useState<"use_srtl" | "import_tags" | null>(null);
  const instanceId = state.settings.id;
  const refresh = useMutation({ mutationKey: policyMutationKey(service), mutationFn: () => service.api.refresh(instanceId), onSuccess: (data) => {
    queryClient.setQueryData(instanceKey(service, instanceId), data);
    void queryClient.invalidateQueries({ queryKey: overviewKey(service), exact: true });
  } });
  const reconcile = useMutation({
    mutationKey: policyMutationKey(service),
    mutationFn: (action: "use_srtl" | "import_tags") => service.api.reconcile(instanceId, selected, action),
    onSuccess: (data) => {
      queryClient.setQueryData(instanceKey(service, instanceId), data);
      void queryClient.invalidateQueries({ queryKey: overviewKey(service), exact: true });
      for (const queryKey of ["storage-policies", "sections", "inventory-summary", "media-links", "media-links-page", "media-link-tree", "dashboard-remote-work-links", "storage-files"]) {
        void queryClient.invalidateQueries({ queryKey: [queryKey] });
      }
      setSelected([]);
      setConfirmation(null);
    }
  });
  const busy = disabled || refresh.isPending || reconcile.isPending;
  const tagsConfigured = Boolean(state.settings.localTag && state.settings.remoteTag);
  const titles = service.titles(state);
  const filtered = titles.filter((movie) => movie.title.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || movie.status === filter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  const selectedMovies = titles.filter((movie) => selected.includes(movie.id));
  const canImport = selectedMovies.length > 0 && selectedMovies.every((movie) => movie.section && movie.tagPolicy !== "conflict" && movie.tagPolicy !== "unassigned" && (movie.policy === "unassigned" || movie.policy === movie.tagPolicy));
  return <section className="radarr-section" aria-labelledby={`${key}-policies-heading`}>
    <div className="radarr-heading"><div className="radarr-help-heading"><h2 id={`${key}-policies-heading`}>Policy synchronization</h2><InfoTooltip label="About policy synchronization">While enabled, every policy you set in SRTL updates the title's {serviceName} tags. Titles without either policy tag follow SRTL automatically. Titles where {serviceName} already has the other policy tag show Needs review until you change their SRTL policy or choose an action below. Refresh preview reads {serviceName} without changing tags; SRTL also refreshes it every 30 minutes.</InfoTooltip></div><button className="secondary" disabled={busy || !state.settings.hasApiKey} onClick={() => refresh.mutate()}>{refresh.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <RefreshCw size={16} />}Refresh preview</button></div>
    {hasUnsavedChanges ? <p className="radarr-draft-notice">Preview and policy actions use saved settings, not your unsaved changes.</p> : null}
    <p className="muted">{state.settings.enabled ? "Active" : "Paused"}{state.settings.lastRefreshAt ? ` - Last refreshed ${formatDate(state.settings.lastRefreshAt)}` : ""}</p>
    {!tagsConfigured ? <p className="muted">Choose and save both policy tags before reconciling titles.</p> : null}
    {state.settings.lastError || refresh.error || reconcile.error ? <p className="error" role="alert">{state.settings.lastError ?? refresh.error?.message ?? reconcile.error?.message}</p> : null}
    <div className="radarr-toolbar">
      <input className="radarr-search" type="search" aria-label={`Search ${serviceName} titles`} placeholder="Search titles" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
      <select aria-label="Filter synchronization status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}><option value="all">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="secondary" disabled={busy || selected.length >= selectionLimit || !visible.some((movie) => movie.section && !selected.includes(movie.id))} onClick={() => { setSelected((ids) => [...new Set([...ids, ...visible.filter((movie) => movie.section).map((movie) => movie.id)])].slice(0, selectionLimit)); setConfirmation(null); }}>Select page</button>
      <button className="secondary" disabled={busy || selected.length >= selectionLimit || !filtered.some((movie) => movie.section && !selected.includes(movie.id))} onClick={() => { setSelected((ids) => [...new Set([...ids, ...filtered.filter((movie) => movie.section).map((movie) => movie.id)])].slice(0, selectionLimit)); setConfirmation(null); }}>Select all matching</button>
      <button className="secondary" disabled={busy || !selected.length} onClick={() => { setSelected([]); setConfirmation(null); }}>Clear selection</button>
    </div>
    <div className="radarr-table-scroll" tabIndex={0} aria-label={`${serviceName} policy preview`}>
      <table><thead><tr><th aria-label="Selection" /><th>Title</th><th>SRTL policy</th><th>{serviceName} tags</th><th>Monitored</th><th>Sync status</th></tr></thead><tbody>
        {visible.map((movie) => <tr key={movie.id}>
          <td><input type="checkbox" aria-label={`Select ${movie.title}`} checked={selected.includes(movie.id)} disabled={busy || !movie.section || (!selected.includes(movie.id) && selected.length >= selectionLimit)} onChange={(event) => { setSelected((ids) => event.target.checked ? [...ids, movie.id] : ids.filter((id) => id !== movie.id)); setConfirmation(null); }} /></td>
          <td><strong>{movie.title}</strong><span className="radarr-path">{movie.folderPath}</span></td>
          <td>{storagePolicyLabel(movie.policy, locations)}</td><td>{movie.tags.join(", ") || "None"}</td><td>{movie.monitored === null ? "-" : movie.monitored ? "Yes" : "No"}</td>
          <td><span className={`radarr-status radarr-status-${movie.status}`}>{statusLabels[movie.status]}</span>{movie.message ? <span className="radarr-path error">{movie.message}</span> : movie.status === "review" ? <span className="radarr-path">{serviceName} tag differs from the SRTL policy</span> : null}</td>
        </tr>)}
      </tbody></table>
    </div>
    {!filtered.length ? <p className="muted">{titles.length ? "No matching titles." : "No titles loaded."}</p> : null}
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
      <p>{confirmation === "use_srtl" ? `Let SRTL manage tags for ${selected.length} titles? Only the ${state.settings.localTag} and ${state.settings.remoteTag} tags will be added or removed to match each SRTL policy. Unassigned titles will have neither tag.` : `Import ${serviceName} policy tags for ${selected.length} titles? SRTL will manage these two tags after import.`} No files will be copied.{!state.settings.enabled ? " Tag updates will wait until the connection is enabled." : ""}</p>
      <div className="radarr-toolbar"><button disabled={busy} onClick={() => reconcile.mutate(confirmation)}>{reconcile.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}{reconcile.isPending ? "Applying..." : "Confirm"}</button><button className="secondary" disabled={busy} onClick={() => setConfirmation(null)}><X size={16} />Cancel</button></div>
    </div> : null}
  </section>;
}
