import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Check, Download, Eye, KeyRound, LoaderCircle, LogIn, Pause, Play, Plus, RefreshCw, Save, Trash2, Upload, Users, X } from "lucide-react";
import {
  watchSyncDirectionLabels,
  type WatchSyncActivityPage,
  type WatchSyncBackup,
  type WatchSyncDirection,
  type WatchSyncPair,
  type WatchSyncPairInput,
  type WatchSyncPairUpdate,
  type WatchSyncPinStatus,
  type WatchSyncPlexPin,
  type WatchSyncPrefixMapping,
  type WatchSyncServer,
  type WatchSyncServerInput,
  type WatchSyncServerKind,
  type WatchSyncSettingsInput,
  type WatchSyncState,
  type WatchSyncUser
} from "../shared/watchSync";
import { request } from "./api";
import { InfoTooltip } from "./App";
import { formatDate } from "./appShared";
import { SettingsTabs } from "./settingsTabs";

const base = "/api/settings/watch-sync";
const stateKey = ["watch-sync"];
const post = <T,>(path: string, body?: unknown) => request<T>(`${base}${path}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const watchSyncApi = {
  state: () => request<WatchSyncState>(base),
  saveSettings: (body: WatchSyncSettingsInput) => request<WatchSyncState>(base, { method: "PUT", body: JSON.stringify(body) }),
  pause: (paused: boolean) => post<WatchSyncState>("/pause", { paused }),
  reconcileAll: () => post<{ jobId: number | null }>("/reconcile"),
  activity: (pairId: number | null) => request<WatchSyncActivityPage>(`${base}/activity?limit=200${pairId ? `&pairId=${pairId}` : ""}`),
  addServer: (kind: WatchSyncServerKind, body: WatchSyncServerInput) => post<WatchSyncState>("/servers", { kind, ...body }),
  updateServer: (id: string, body: WatchSyncServerInput) => request<WatchSyncState>(`${base}/servers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  removeServer: (id: string) => request<WatchSyncState>(`${base}/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  discover: (id: string) => post<WatchSyncState>(`/servers/${encodeURIComponent(id)}/discover`),
  startPin: (id: string) => post<WatchSyncPlexPin>(`/servers/${encodeURIComponent(id)}/plex-pin`),
  checkPin: (id: string, pinId: number) => post<WatchSyncPinStatus>(`/servers/${encodeURIComponent(id)}/plex-pin/${pinId}`),
  addPair: (body: WatchSyncPairInput) => post<WatchSyncState>("/pairs", body),
  updatePair: (id: number, body: WatchSyncPairUpdate) => request<WatchSyncState>(`${base}/pairs/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  removePair: (id: number) => request<WatchSyncState>(`${base}/pairs/${id}`, { method: "DELETE" }),
  preview: (id: number) => post<{ jobId: number }>(`/pairs/${id}/preview`),
  approve: (id: number) => post<{ jobId: number }>(`/pairs/${id}/approve`),
  syncNow: (id: number) => post<{ jobId: number }>(`/pairs/${id}/sync`),
  restore: (id: number, side: "plex" | "jellyfin", backup: WatchSyncBackup) => post<{ jobId: number }>(`/pairs/${id}/restore`, { side, backup })
};

const tabs = [
  { key: "servers", label: "Servers" },
  { key: "pairs", label: "User pairs" },
  { key: "options", label: "Options" },
  { key: "activity", label: "Activity" }
] as const;
type Tab = (typeof tabs)[number]["key"];
const tabStorageKey = "srtl-watch-sync-tab";

function readStoredTab(): Tab {
  try {
    const stored = window.localStorage.getItem(tabStorageKey);
    return tabs.find((tab) => tab.key === stored)?.key ?? "servers";
  } catch {
    return "servers";
  }
}

const kindLabel = (kind: WatchSyncServerKind) => kind === "plex" ? "Plex" : "Jellyfin";
const userKindLabels: Record<WatchSyncUser["kind"], string> = { owner: "Owner", home: "Plex Home", managed: "Managed", friend: "Friend", user: "User" };

function useStateUpdate() {
  const queryClient = useQueryClient();
  return (state: WatchSyncState) => queryClient.setQueryData(stateKey, state);
}

function Section({ title, help, actions, children }: { title: string; help?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section className="radarr-section">
    <div className="radarr-heading">
      <div className="radarr-help-heading"><h2>{title}</h2>{help ? <InfoTooltip label={`About ${title}`}>{help}</InfoTooltip> : null}</div>
      {actions ? <div className="radarr-toolbar">{actions}</div> : null}
    </div>
    {children}
  </section>;
}

export function WatchSyncSettingsPanel({ active }: { active: boolean }) {
  // Nothing is fetched until the tab is opened, so the other integrations never wait on watch sync.
  const query = useQuery({ queryKey: stateKey, queryFn: watchSyncApi.state, enabled: active, refetchInterval: active ? 5000 : false });
  const [tab, setTab] = useState<Tab>(readStoredTab);
  const select = (next: Tab) => {
    setTab(next);
    try { window.localStorage.setItem(tabStorageKey, next); } catch { /* the tab still applies for this page view */ }
  };
  if (!active && !query.data) return null;
  if (query.isLoading) return <p role="status">Loading watch sync...</p>;
  if (!query.data?.settings) return <p className="error" role="alert">{query.error?.message ?? "Watch sync settings unavailable."}</p>;
  const state = query.data;
  return <div className="radarr-settings watch-sync-settings">
    <WatchSyncHeader state={state} />
    {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
    <div className="radarr-tabs-area">
      <SettingsTabs label="Watch sync" idPrefix="watch-sync" className="radarr-tabs" tabs={tabs} active={tab} onSelect={select} />
      <div role="tabpanel" id="watch-sync-panel-servers" aria-labelledby="watch-sync-tab-servers" hidden={tab !== "servers"} className="radarr-tab-panel"><ServersTab state={state} /></div>
      <div role="tabpanel" id="watch-sync-panel-pairs" aria-labelledby="watch-sync-tab-pairs" hidden={tab !== "pairs"} className="radarr-tab-panel"><PairsTab state={state} /></div>
      <div role="tabpanel" id="watch-sync-panel-options" aria-labelledby="watch-sync-tab-options" hidden={tab !== "options"} className="radarr-tab-panel"><OptionsTab key={state.settings.revision} state={state} /></div>
      <div role="tabpanel" id="watch-sync-panel-activity" aria-labelledby="watch-sync-tab-activity" hidden={tab !== "activity"} className="radarr-tab-panel">{tab === "activity" ? <ActivityTab state={state} /> : null}</div>
    </div>
  </div>;
}

function WatchSyncHeader({ state }: { state: WatchSyncState }) {
  const setState = useStateUpdate();
  const pause = useMutation({ mutationFn: (paused: boolean) => watchSyncApi.pause(paused), onSuccess: setState });
  const reconcile = useMutation({ mutationFn: watchSyncApi.reconcileAll });
  const { settings } = state;
  const syncing = state.pairs.filter((pair) => pair.approvedAt && pair.enabled && !pair.paused).length;
  return <div className="radarr-integration-header">
    <div className="radarr-heading">
      <div className="radarr-help-heading">
        <h2><ArrowLeftRight size={18} />Watch sync</h2>
        <InfoTooltip label="About watch sync">Keeps watched state and resume positions in sync between Plex and Jellyfin users. Items are matched by the exact SRTL symlink path both servers read, so titles never need to match. Each user pair syncs one way or both ways, and nothing is written for a pair until you approve its preview.</InfoTooltip>
      </div>
      <div className="radarr-toolbar">
        <button type="button" className="secondary" disabled={reconcile.isPending || !syncing || settings.paused} onClick={() => reconcile.mutate()} title="Read every paired user's whole library on both servers and fix any difference"><RefreshCw size={16} />Full reconciliation</button>
        <button type="button" className={settings.paused ? undefined : "secondary"} disabled={pause.isPending} onClick={() => pause.mutate(!settings.paused)}>{settings.paused ? <><Play size={16} />Resume all</> : <><Pause size={16} />Pause all</>}</button>
      </div>
    </div>
    <p className="radarr-state" role="status">
      {settings.paused ? "Paused: nothing is read or written until you resume." : `${syncing} pair${syncing === 1 ? "" : "s"} syncing every ${settings.intervalMinutes} minute${settings.intervalMinutes === 1 ? "" : "s"}.`}
      {" "}Last full reconciliation: {settings.lastReconcileAt ? formatDate(settings.lastReconcileAt) : "not yet"}.
      {state.activeJobs.length ? ` Job #${state.activeJobs[0]!.id} (${state.activeJobs[0]!.mode}) is ${state.activeJobs[0]!.status}.` : ""}
    </p>
    {pause.error ? <p className="error" role="alert">{pause.error.message}</p> : null}
    {reconcile.data ? <p className="success" role="status">{reconcile.data.jobId ? `Queued job #${reconcile.data.jobId}.` : "No approved pairs to reconcile."}</p> : null}
    {reconcile.error ? <p className="error" role="alert">{reconcile.error.message}</p> : null}
  </div>;
}

function ServersTab({ state }: { state: WatchSyncState }) {
  const [adding, setAdding] = useState<WatchSyncServerKind | null>(null);
  return <>
    <Section title="Media servers" help="Add each Plex and Jellyfin server whose users should stay in sync. Plex signs in through plex.tv; Jellyfin uses an API key from Dashboard > API Keys." actions={<>
      <button type="button" className="secondary" disabled={adding !== null} onClick={() => setAdding("plex")}><Plus size={16} />Add Plex server</button>
      <button type="button" className="secondary" disabled={adding !== null} onClick={() => setAdding("jellyfin")}><Plus size={16} />Add Jellyfin server</button>
    </>}>
      <p className="radarr-lede">Both servers must read the same SRTL symlinks. If a server sees the library under a different folder than SRTL does, add a path prefix mapping, for example <code>/data/media</code> on the server is <code>/mnt/plex</code> in SRTL.</p>
      {adding ? <ServerForm kind={adding} onDone={() => setAdding(null)} /> : null}
      {!state.settings.servers.length && !adding ? <p className="muted">No media servers yet. Add a Plex server and a Jellyfin server to start.</p> : null}
    </Section>
    {state.settings.servers.map((server) => <ServerCard key={`${server.id}:${state.settings.revision}`} server={server} state={state} />)}
  </>;
}

function PrefixMappings({ value, onChange, disabled }: { value: WatchSyncPrefixMapping[]; onChange: (next: WatchSyncPrefixMapping[]) => void; disabled?: boolean }) {
  return <div className="watch-sync-prefixes">
    <div className="radarr-field-label"><span className="watch-sync-label">Path prefix mappings</span><InfoTooltip label="About path prefix mappings">Optional. When this server lists a file under a different folder than SRTL's symlink folder, map the server's prefix to SRTL's. The longest matching prefix is used.</InfoTooltip></div>
    {value.map((mapping, index) => <div key={index} className="radarr-toolbar watch-sync-prefix">
      <input aria-label="Server path prefix" placeholder="/data/media" value={mapping.serverPrefix} disabled={disabled} onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, serverPrefix: event.target.value } : entry))} />
      <span aria-hidden="true">→</span>
      <input aria-label="SRTL path prefix" placeholder="/mnt/plex" value={mapping.srtlPrefix} disabled={disabled} onChange={(event) => onChange(value.map((entry, position) => position === index ? { ...entry, srtlPrefix: event.target.value } : entry))} />
      <button type="button" className="secondary icon-only" aria-label="Remove mapping" disabled={disabled} onClick={() => onChange(value.filter((_entry, position) => position !== index))}><X size={16} /></button>
    </div>)}
    <button type="button" className="link-button" disabled={disabled || value.length >= 20} onClick={() => onChange([...value, { serverPrefix: "", srtlPrefix: "" }])}><Plus size={14} />Add mapping</button>
  </div>;
}

function ServerFields({ kind, draft, setDraft, hasToken, disabled }: { kind: WatchSyncServerKind; draft: WatchSyncServerInput; setDraft: (draft: WatchSyncServerInput) => void; hasToken: boolean; disabled: boolean }) {
  const tokenId = useId();
  const tokenLabel = kind === "plex" ? "Plex token (optional)" : "API key";
  const tokenHelp = kind === "plex"
    ? "Use Sign in with Plex instead when you can. If you paste a token, use your account's token, never the PlexOnlineToken from the server's Preferences.xml."
    : "Create one in Jellyfin under Dashboard > API Keys. It is stored on the SRTL server and never shown again.";
  return <fieldset className="radarr-fields" disabled={disabled}>
    <div className="radarr-grid">
      <label>Name<input required maxLength={60} value={draft.name} placeholder={kind === "plex" ? "Home Plex" : "Jellyfin"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Server URL<input required value={draft.url} placeholder={kind === "plex" ? "http://192.168.1.10:32400" : "http://192.168.1.10:8096"} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
    </div>
    <div className="radarr-field">
      <div className="radarr-field-label"><label htmlFor={tokenId}>{tokenLabel}</label><InfoTooltip label={`About the ${tokenLabel}`}>{tokenHelp}</InfoTooltip></div>
      <input id={tokenId} type="password" autoComplete="off" value={draft.token ?? ""} placeholder={hasToken ? "Saved. Leave empty to keep it." : ""} onChange={(event) => setDraft({ ...draft, token: event.target.value })} />
    </div>
    <PrefixMappings value={draft.prefixMappings} onChange={(prefixMappings) => setDraft({ ...draft, prefixMappings })} />
  </fieldset>;
}

function cleanMappings(draft: WatchSyncServerInput): WatchSyncServerInput {
  return { ...draft, prefixMappings: draft.prefixMappings.filter((mapping) => mapping.serverPrefix.trim() || mapping.srtlPrefix.trim()) };
}

function ServerForm({ kind, onDone }: { kind: WatchSyncServerKind; onDone: () => void }) {
  const setState = useStateUpdate();
  const [draft, setDraft] = useState<WatchSyncServerInput>({ name: "", url: "", token: "", prefixMappings: [] });
  const add = useMutation({ mutationFn: () => watchSyncApi.addServer(kind, cleanMappings(draft)), onSuccess: (state) => { setState(state); onDone(); } });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!add.isPending) add.mutate(); };
  return <form className="watch-sync-card" aria-label={`Add ${kindLabel(kind)} server`} onSubmit={submit}>
    <h3>Add a {kindLabel(kind)} server</h3>
    <ServerFields kind={kind} draft={draft} setDraft={setDraft} hasToken={false} disabled={add.isPending} />
    {kind === "plex" ? <p className="muted">After adding it, use <strong>Sign in with Plex</strong> to connect as the server owner.</p> : null}
    <div className="radarr-toolbar">
      <button type="submit" disabled={add.isPending || !draft.name.trim() || !draft.url.trim()}>{add.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}Add server</button>
      <button type="button" className="secondary" disabled={add.isPending} onClick={onDone}><X size={16} />Cancel</button>
    </div>
    {add.error ? <p className="error" role="alert">{add.error.message}</p> : null}
  </form>;
}

function PlexSignIn({ server }: { server: WatchSyncServer }) {
  const setState = useStateUpdate();
  const [pin, setPin] = useState<WatchSyncPlexPin | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => watchSyncApi.startPin(server.id),
    onSuccess: (created) => {
      setPin(created);
      setMessage(null);
      window.open(created.authUrl, "_blank", "noopener");
    }
  });
  useEffect(() => {
    if (!pin) return undefined;
    let stopped = false;
    const timer = window.setInterval(() => {
      watchSyncApi.checkPin(server.id, pin.pinId).then((status) => {
        if (stopped) return;
        if (status.status === "authorized") {
          if (status.state) setState(status.state);
          setPin(null);
          setMessage("Signed in. Users were discovered.");
        } else if (status.status === "expired") {
          setPin(null);
          setMessage("The sign-in expired. Start it again.");
        }
      }).catch((error: unknown) => {
        if (stopped) return;
        setPin(null);
        setMessage(error instanceof Error ? error.message : "Sign-in failed.");
      });
    }, 3000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [pin, server.id, setState]);
  return <div className="watch-sync-signin">
    <button type="button" disabled={start.isPending || Boolean(pin)} onClick={() => start.mutate()}>{pin ? <LoaderCircle size={16} className="spin-icon" /> : <LogIn size={16} />}{server.hasToken ? "Sign in with Plex again" : "Sign in with Plex"}</button>
    {pin ? <p className="muted" role="status">Waiting for plex.tv. Approve the sign-in in the window that opened, or <a href={pin.authUrl} target="_blank" rel="noopener noreferrer">open it here</a> (code {pin.code}).</p> : null}
    {message ? <p className={message.startsWith("Signed in") ? "success" : "error"} role="status">{message}</p> : null}
    {start.error ? <p className="error" role="alert">{start.error.message}</p> : null}
  </div>;
}

function ServerCard({ server, state }: { server: WatchSyncServer; state: WatchSyncState }) {
  const setState = useStateUpdate();
  const [draft, setDraft] = useState<WatchSyncServerInput>({ name: server.name, url: server.url, token: "", prefixMappings: server.prefixMappings });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useMutation({ mutationFn: () => watchSyncApi.updateServer(server.id, cleanMappings(draft)), onSuccess: setState });
  const discover = useMutation({ mutationFn: () => watchSyncApi.discover(server.id), onSuccess: setState });
  const remove = useMutation({ mutationFn: () => watchSyncApi.removeServer(server.id), onSuccess: setState });
  const users = state.users.filter((user) => user.serverId === server.id);
  const busy = save.isPending || discover.isPending || remove.isPending;
  const changed = draft.name !== server.name || draft.url !== server.url || Boolean(draft.token) || JSON.stringify(draft.prefixMappings) !== JSON.stringify(server.prefixMappings);
  return <section className="radarr-section watch-sync-server" aria-label={`${kindLabel(server.kind)} server ${server.name}`}>
    <div className="radarr-heading">
      <h2>{server.name}<span className="watch-sync-pill">{kindLabel(server.kind)}</span></h2>
      <div className="radarr-toolbar">
        <button type="button" className="secondary" disabled={busy || !server.hasToken} onClick={() => discover.mutate()}>{discover.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Users size={16} />}Test and discover users</button>
        <button type="button" className="secondary icon-only" aria-label={`Remove ${server.name}`} disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} /></button>
      </div>
    </div>
    <p className={server.lastError ? "radarr-state error" : "radarr-state"}>
      {server.lastError ?? (server.lastCheckedAt ? `Connected, checked ${formatDate(server.lastCheckedAt)}` : server.hasToken ? "Not checked yet" : server.kind === "plex" ? "Not signed in" : "No API key")}
      {server.accountName ? ` · Plex account ${server.accountName}` : ""}
      {` · ${users.length} user${users.length === 1 ? "" : "s"} · ${state.indexedItems[server.id] ?? 0} SRTL items indexed`}
    </p>
    {confirmRemove ? <div className="radarr-confirmation" role="group" aria-label={`Confirm removing ${server.name}`}>
      <p>Remove {server.name}? SRTL forgets its users, pairs, item index, and saved watch snapshots. Nothing changes on the server.</p>
      <div className="radarr-toolbar">
        <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={16} />Remove</button>
        <button type="button" className="secondary" onClick={() => setConfirmRemove(false)}>Cancel</button>
      </div>
    </div> : null}
    {server.kind === "plex" ? <PlexSignIn server={server} /> : null}
    <details className="radarr-setup watch-sync-edit">
      <summary>Connection and path mappings</summary>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) save.mutate(); }}>
        <ServerFields kind={server.kind} draft={draft} setDraft={setDraft} hasToken={server.hasToken} disabled={busy} />
        <div className="radarr-toolbar"><button type="submit" disabled={busy || !changed}>{save.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Save size={16} />}Save</button></div>
      </form>
    </details>
    {users.length ? <ul className="watch-sync-users">
      {users.map((user) => <li key={user.externalId} className={user.ready ? undefined : "muted"} title={user.note ?? undefined}>
        <strong>{user.name}</strong>{user.username && user.username !== user.name ? ` (${user.username})` : ""} <span className="watch-sync-pill">{userKindLabels[user.kind]}</span>
        {user.ready ? null : <span className="watch-sync-note"> {user.note ?? "Not available"}</span>}
      </li>)}
    </ul> : null}
    {[save.error, discover.error, remove.error].map((error, index) => error ? <p key={index} className="error" role="alert">{error.message}</p> : null)}
  </section>;
}

function userLabel(state: WatchSyncState, serverId: string, user: WatchSyncUser) {
  const servers = state.settings.servers.filter((server) => server.kind === state.settings.servers.find((entry) => entry.id === serverId)?.kind);
  const server = state.settings.servers.find((entry) => entry.id === serverId);
  return servers.length > 1 && server ? `${user.name} (${server.name})` : user.name;
}

function PairsTab({ state }: { state: WatchSyncState }) {
  const setState = useStateUpdate();
  const plexUsers = state.users.filter((user) => state.settings.servers.some((server) => server.id === user.serverId && server.kind === "plex"));
  const jellyfinUsers = state.users.filter((user) => user.ready && state.settings.servers.some((server) => server.id === user.serverId && server.kind === "jellyfin"));
  const [plexChoice, setPlexChoice] = useState("");
  const [jellyfinChoice, setJellyfinChoice] = useState("");
  const [direction, setDirection] = useState<WatchSyncDirection>("both");
  const add = useMutation({ mutationFn: (input: WatchSyncPairInput) => watchSyncApi.addPair(input), onSuccess: (next) => { setState(next); setPlexChoice(""); setJellyfinChoice(""); } });
  const split = (value: string) => { const [serverId, ...rest] = value.split("\0"); return { serverId: serverId ?? "", userId: rest.join("\0") }; };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const plex = split(plexChoice);
    const jellyfin = split(jellyfinChoice);
    add.mutate({ plexServerId: plex.serverId, plexUserId: plex.userId, jellyfinServerId: jellyfin.serverId, jellyfinUserId: jellyfin.userId, direction });
  };
  return <>
    {state.suggestions.length ? <Section title="Suggested pairs" help="Users whose names match once case, punctuation, and trailing digits are ignored, such as alex_03 and Alex. Check each one before pairing.">
      <ul className="watch-sync-suggestions">
        {state.suggestions.map((suggestion) => <li key={`${suggestion.plexServerId}:${suggestion.plexUserId}:${suggestion.jellyfinServerId}`}>
          <span><strong>{suggestion.plexUserName}</strong> (Plex) ↔ <strong>{suggestion.jellyfinUserName}</strong> (Jellyfin){suggestion.match === "similar" ? <span className="watch-sync-pill">similar name</span> : null}</span>
          <button type="button" className="secondary" disabled={add.isPending} onClick={() => add.mutate({ plexServerId: suggestion.plexServerId, plexUserId: suggestion.plexUserId, jellyfinServerId: suggestion.jellyfinServerId, jellyfinUserId: suggestion.jellyfinUserId, direction: "both" })}><Plus size={16} />Pair</button>
        </li>)}
      </ul>
    </Section> : null}
    <Section title="Pair users" help="A Plex user may be paired with several Jellyfin users, and the other way round. Each pair has its own direction.">
      {!plexUsers.length || !jellyfinUsers.length ? <p className="muted">Connect a Plex and a Jellyfin server and discover their users first.</p> : <form className="radarr-toolbar watch-sync-pair-form" onSubmit={submit}>
        <select aria-label="Plex user" required value={plexChoice} onChange={(event) => setPlexChoice(event.target.value)}>
          <option value="">Plex user...</option>
          {plexUsers.map((user) => <option key={`${user.serverId}:${user.externalId}`} value={`${user.serverId}\0${user.externalId}`} disabled={!user.ready}>{userLabel(state, user.serverId, user)}{user.ready ? "" : " (no access token)"}</option>)}
        </select>
        <select aria-label="Direction" value={direction} onChange={(event) => setDirection(event.target.value as WatchSyncDirection)}>
          {Object.entries(watchSyncDirectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Jellyfin user" required value={jellyfinChoice} onChange={(event) => setJellyfinChoice(event.target.value)}>
          <option value="">Jellyfin user...</option>
          {jellyfinUsers.map((user) => <option key={`${user.serverId}:${user.externalId}`} value={`${user.serverId}\0${user.externalId}`}>{userLabel(state, user.serverId, user)}</option>)}
        </select>
        <button type="submit" disabled={add.isPending || !plexChoice || !jellyfinChoice}><Plus size={16} />Add pair</button>
      </form>}
      {add.error ? <p className="error" role="alert">{add.error.message}</p> : null}
    </Section>
    <Section title="Pairs">
      {state.pairs.length ? <div className="watch-sync-pairs">{state.pairs.map((pair) => <PairCard key={pair.id} pair={pair} state={state} />)}</div> : <p className="muted">No pairs yet.</p>}
    </Section>
  </>;
}

function pairStatus(pair: WatchSyncPair, state: WatchSyncState): { label: string; kind: "enabled" | "paused" | "error" | "new" } {
  if (pair.lastError) return { label: "Retrying", kind: "error" };
  if (!pair.enabled) return { label: "Disabled", kind: "paused" };
  if (pair.paused || state.settings.paused) return { label: "Paused", kind: "paused" };
  if (!pair.approvedAt) return { label: pair.preview ? "Preview ready" : "Needs preview", kind: "new" };
  if (!pair.lastFullSyncAt) return { label: "First sync pending", kind: "new" };
  return { label: "Syncing", kind: "enabled" };
}

const toggleValue = (value: boolean | null) => value === null ? "default" : value ? "on" : "off";
const fromToggle = (value: string) => value === "default" ? null : value === "on";

function PairCard({ pair, state }: { pair: WatchSyncPair; state: WatchSyncState }) {
  const setState = useStateUpdate();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [restoreSide, setRestoreSide] = useState<"plex" | "jellyfin">("jellyfin");
  const fileInput = useRef<HTMLInputElement>(null);
  const update = useMutation({ mutationFn: (body: WatchSyncPairUpdate) => watchSyncApi.updatePair(pair.id, body), onSuccess: setState });
  const remove = useMutation({ mutationFn: () => watchSyncApi.removePair(pair.id), onSuccess: setState });
  const preview = useMutation({ mutationFn: () => watchSyncApi.preview(pair.id) });
  const approve = useMutation({ mutationFn: () => watchSyncApi.approve(pair.id) });
  const syncNow = useMutation({ mutationFn: () => watchSyncApi.syncNow(pair.id) });
  const restore = useMutation({
    mutationFn: async (file: File) => {
      let backup: WatchSyncBackup;
      try { backup = JSON.parse(await file.text()) as WatchSyncBackup; } catch { throw new Error("This file is not a watch state backup."); }
      return watchSyncApi.restore(pair.id, restoreSide, backup);
    }
  });
  const status = pairStatus(pair, state);
  const jobBusy = state.activeJobs.length > 0;
  const busy = update.isPending || remove.isPending || preview.isPending || approve.isPending || syncNow.isPending || restore.isPending;
  const queued = preview.data?.jobId ?? approve.data?.jobId ?? syncNow.data?.jobId ?? restore.data?.jobId;
  return <article className="watch-sync-card" aria-label={`${pair.plexUserName} and ${pair.jellyfinUserName}`}>
    <div className="radarr-heading">
      <h3>{pair.plexUserName} <span className="muted">Plex</span> ↔ {pair.jellyfinUserName} <span className="muted">Jellyfin</span></h3>
      <span className={`radarr-instance-status radarr-instance-status-${status.kind}`}>{status.label}</span>
    </div>
    <div className="radarr-toolbar watch-sync-pair-options">
      <label>Direction <select value={pair.direction} disabled={busy} onChange={(event) => update.mutate({ direction: event.target.value as WatchSyncDirection })}>
        {Object.entries(watchSyncDirectionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Watched <select value={toggleValue(pair.syncWatched)} disabled={busy} onChange={(event) => update.mutate({ syncWatched: fromToggle(event.target.value) })}>
        <option value="default">Default ({state.settings.syncWatched ? "on" : "off"})</option><option value="on">On</option><option value="off">Off</option>
      </select></label>
      <label>Resume position <select value={toggleValue(pair.syncPosition)} disabled={busy} onChange={(event) => update.mutate({ syncPosition: fromToggle(event.target.value) })}>
        <option value="default">Default ({state.settings.syncPosition ? "on" : "off"})</option><option value="on">On</option><option value="off">Off</option>
      </select></label>
      <label className="radarr-toggle"><input type="checkbox" checked={pair.enabled} disabled={busy} onChange={(event) => update.mutate({ enabled: event.target.checked })} />Enabled</label>
    </div>
    <p className="radarr-state">
      {pair.lastError ? <span className="error">{pair.lastError} </span> : null}
      {pair.lastSyncAt ? `Last synced ${formatDate(pair.lastSyncAt)}` : "Not synced yet"} · {pair.trackedItems} item{pair.trackedItems === 1 ? "" : "s"} tracked
    </p>
    {pair.preview && !pair.approvedAt ? <PreviewSummary pair={pair} /> : null}
    <div className="radarr-toolbar">
      <button type="button" className={pair.approvedAt ? "secondary" : undefined} disabled={busy || jobBusy} onClick={() => preview.mutate()}><Eye size={16} />{pair.preview ? "Preview again" : "Preview"}</button>
      {!pair.approvedAt ? <button type="button" disabled={busy || jobBusy || !pair.preview} onClick={() => approve.mutate()} title={pair.preview ? undefined : "Run a preview first"}><Check size={16} />Approve and start syncing</button> : <>
        <button type="button" className="secondary" disabled={busy || jobBusy || pair.paused || !pair.enabled} onClick={() => syncNow.mutate()}><RefreshCw size={16} />Full sync now</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => update.mutate({ paused: !pair.paused })}>{pair.paused ? <><Play size={16} />Resume</> : <><Pause size={16} />Pause</>}</button>
      </>}
      <a className="watch-sync-link-button" href={`${base}/pairs/${pair.id}/backup`} download><Download size={16} />Back up</a>
      <button type="button" className="secondary icon-only" aria-label="Remove pair" disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} /></button>
    </div>
    <details className="radarr-setup">
      <summary>Restore from a backup</summary>
      <p className="muted">Writes the backup's watched states and resume positions to one server for this pair. The pair's next sync carries them to the other server if its direction allows.</p>
      <div className="radarr-toolbar">
        <select aria-label="Restore to" value={restoreSide} onChange={(event) => setRestoreSide(event.target.value as "plex" | "jellyfin")}><option value="jellyfin">Restore to Jellyfin</option><option value="plex">Restore to Plex</option></select>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) restore.mutate(file); event.target.value = ""; }} />
        <button type="button" className="secondary" disabled={busy || jobBusy} onClick={() => fileInput.current?.click()}><Upload size={16} />Choose backup file</button>
      </div>
    </details>
    {confirmRemove ? <div className="radarr-confirmation" role="group" aria-label="Confirm removing this pair">
      <p>Remove this pair? Its snapshots and activity are forgotten. Nothing changes on either server.</p>
      <div className="radarr-toolbar">
        <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={16} />Remove</button>
        <button type="button" className="secondary" onClick={() => setConfirmRemove(false)}>Cancel</button>
      </div>
    </div> : null}
    {queued ? <p className="success" role="status">Queued job #{queued}. Progress shows in Activity and on the Jobs page.</p> : null}
    {[update.error, remove.error, preview.error, approve.error, syncNow.error, restore.error].map((error, index) => error ? <p key={index} className="error" role="alert">{error.message}</p> : null)}
  </article>;
}

function PreviewSummary({ pair }: { pair: WatchSyncPair }) {
  const preview = pair.preview!;
  const actionLabel = { watched: "mark watched", unwatched: "mark unwatched", position: "set resume position" } as const;
  const row = (direction: "plex_to_jellyfin" | "jellyfin_to_plex") => {
    const counts = preview.counts[direction];
    return <li>{watchSyncDirectionLabels[direction]}: {counts.watched} watched, {counts.unwatched} unwatched, {counts.position} resume position{counts.position === 1 ? "" : "s"}</li>;
  };
  return <div className="watch-sync-preview" role="region" aria-label="Preview">
    <p><strong>Preview from {formatDate(preview.generatedAt)}.</strong> Nothing has been written yet. {preview.matched} items are on both servers; {preview.skipped} listed items are not SRTL paths and are skipped.</p>
    <ul>{pair.direction !== "jellyfin_to_plex" ? row("plex_to_jellyfin") : null}{pair.direction !== "plex_to_jellyfin" ? row("jellyfin_to_plex") : null}</ul>
    {preview.samples.length ? <details>
      <summary>Show {preview.samples.length} example{preview.samples.length === 1 ? "" : "s"}</summary>
      <ul className="watch-sync-samples">{preview.samples.map((sample) => <li key={`${sample.direction}:${sample.linkPath}`}>{watchSyncDirectionLabels[sample.direction]}: {actionLabel[sample.action]}{sample.positionMs !== null ? ` (${Math.round(sample.positionMs / 60_000)} min)` : ""} · {sample.title}<span className="radarr-path">{sample.linkPath}</span></li>)}</ul>
    </details> : <p className="muted">Both servers already agree.</p>}
  </div>;
}

function OptionsTab({ state }: { state: WatchSyncState }) {
  const setState = useStateUpdate();
  const { settings } = state;
  const [draft, setDraft] = useState<WatchSyncSettingsInput>({ revision: settings.revision, paused: settings.paused, intervalMinutes: settings.intervalMinutes, reconcileIntervalDays: settings.reconcileIntervalDays, syncWatched: settings.syncWatched, syncPosition: settings.syncPosition });
  const save = useMutation({ mutationFn: () => watchSyncApi.saveSettings({ ...draft, paused: settings.paused }), onSuccess: setState });
  return <Section title="Options">
    <form onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(); }}>
      <fieldset className="radarr-fields" disabled={save.isPending}>
        <div className="radarr-grid">
          <label>Check for changes every (minutes)<input type="number" min={1} max={1440} required value={draft.intervalMinutes} onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label>
          <label>Full reconciliation every (days)<input type="number" min={1} max={90} required value={draft.reconcileIntervalDays} onChange={(event) => setDraft({ ...draft, reconcileIntervalDays: Number(event.target.value) })} /></label>
        </div>
        <label className="radarr-toggle"><input type="checkbox" checked={draft.syncWatched} onChange={(event) => setDraft({ ...draft, syncWatched: event.target.checked })} />Sync watched and unwatched (default for pairs)</label>
        <label className="radarr-toggle"><input type="checkbox" checked={draft.syncPosition} onChange={(event) => setDraft({ ...draft, syncPosition: event.target.checked })} />Sync resume positions (default for pairs)</label>
        <p className="muted">Each check reads only what changed since the last one. The full reconciliation reads every paired user's whole library on both servers, page by page, and runs as a job you can follow on the Jobs page. Watches that SRTL marks through the Plex API do not appear as plays in Tautulli.</p>
        <div className="radarr-toolbar"><button type="submit" disabled={save.isPending}>{save.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Save size={16} />}Save options</button></div>
      </fieldset>
    </form>
    {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
  </Section>;
}

function ActivityTab({ state }: { state: WatchSyncState }) {
  const [pairId, setPairId] = useState<number | null>(null);
  const activity = useQuery({ queryKey: ["watch-sync", "activity", pairId], queryFn: () => watchSyncApi.activity(pairId), refetchInterval: 5000 });
  const pairName = (id: number | null) => {
    const pair = state.pairs.find((entry) => entry.id === id);
    return pair ? `${pair.plexUserName} ↔ ${pair.jellyfinUserName}` : "";
  };
  return <Section title="Activity" actions={<select aria-label="Pair" value={pairId ?? ""} onChange={(event) => setPairId(event.target.value ? Number(event.target.value) : null)}>
    <option value="">All pairs</option>
    {state.pairs.map((pair) => <option key={pair.id} value={pair.id}>{pairName(pair.id)}</option>)}
  </select>}>
    {activity.error ? <p className="error" role="alert">{activity.error.message}</p> : null}
    {activity.data?.entries.length ? <div className="radarr-table-scroll" tabIndex={0} aria-label="Watch sync activity">
      <table><thead><tr><th>When</th><th>Pair</th><th>Change</th><th>Job</th></tr></thead><tbody>
        {activity.data.entries.map((entry) => <tr key={entry.id}>
          <td className="radarr-nowrap">{formatDate(entry.at)}</td>
          <td>{pairName(entry.pairId)}</td>
          <td className={entry.level === "error" ? "error" : undefined}>{entry.message}{entry.linkPath ? <span className="radarr-path">{entry.linkPath}</span> : null}</td>
          <td>{entry.jobId ? `#${entry.jobId}` : "Timer"}</td>
        </tr>)}
      </tbody></table>
    </div> : activity.isLoading ? <p role="status">Loading activity...</p> : <p className="muted">No activity yet. Changes appear here as they are synced, kept for 30 days.</p>}
    <p className="muted"><KeyRound size={14} /> Plex tokens and Jellyfin API keys are stored only on the SRTL server.</p>
  </Section>;
}
