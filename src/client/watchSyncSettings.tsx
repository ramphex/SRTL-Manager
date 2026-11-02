import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, Check, Download, Eye, KeyRound, LoaderCircle, Pause, Play, Plus, RefreshCw, Save, Settings, Trash2, Upload, Users } from "lucide-react";
import { mediaServerKindLabels, type MediaServer } from "../shared/mediaServers";
import {
  watchSyncDirectionLabels,
  type WatchSyncActivityPage,
  type WatchSyncBackup,
  type WatchSyncDirection,
  type WatchSyncPair,
  type WatchSyncPairInput,
  type WatchSyncPairUpdate,
  type WatchSyncSettingsInput,
  type WatchSyncState,
  type WatchSyncUser
} from "../shared/watchSync";
import { request } from "./api";
import { InfoTooltip } from "./App";
import { formatDate } from "./appShared";
import { mediaServerStatus, mediaServersKey } from "./mediaServerApi";
import { MediaServersRequired } from "./mediaServersRequired";
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
  discover: (id: string) => post<WatchSyncState>(`/servers/${encodeURIComponent(id)}/discover`),
  addPair: (body: WatchSyncPairInput) => post<WatchSyncState>("/pairs", body),
  updatePair: (id: number, body: WatchSyncPairUpdate) => request<WatchSyncState>(`${base}/pairs/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  removePair: (id: number) => request<WatchSyncState>(`${base}/pairs/${id}`, { method: "DELETE" }),
  preview: (id: number) => post<{ jobId: number }>(`/pairs/${id}/preview`),
  approve: (id: number) => post<{ jobId: number }>(`/pairs/${id}/approve`),
  syncNow: (id: number) => post<{ jobId: number }>(`/pairs/${id}/sync`),
  restore: (id: number, side: "plex" | "jellyfin", backup: WatchSyncBackup) => post<{ jobId: number }>(`/pairs/${id}/restore`, { side, backup })
};

const tabs = [
  { key: "users", label: "Users" },
  { key: "pairs", label: "User pairs" },
  { key: "options", label: "Options" },
  { key: "activity", label: "Activity" }
] as const;
type Tab = (typeof tabs)[number]["key"];
const tabStorageKey = "srtl-watch-sync-tab";

function readStoredTab(): Tab {
  try {
    const stored = window.localStorage.getItem(tabStorageKey);
    return tabs.find((tab) => tab.key === stored)?.key ?? "users";
  } catch {
    return "users";
  }
}

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
  // Connections live in Settings > Media servers; without one, there is nothing to sync yet.
  if (!state.servers.some((server) => server.hasToken) && !state.pairs.length) {
    return <div className="radarr-settings watch-sync-settings">
      <MediaServersRequired title="Watch sync needs a media server">
        <p className="muted">Watch sync pairs Plex users with Jellyfin users, so connect at least one Plex server and one Jellyfin server.</p>
      </MediaServersRequired>
    </div>;
  }
  return <div className="radarr-settings watch-sync-settings">
    <WatchSyncHeader state={state} />
    {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
    <div className="radarr-tabs-area">
      <SettingsTabs label="Watch sync" idPrefix="watch-sync" className="radarr-tabs" tabs={tabs} active={tab} onSelect={select} />
      <div role="tabpanel" id="watch-sync-panel-users" aria-labelledby="watch-sync-tab-users" hidden={tab !== "users"} className="radarr-tab-panel"><UsersTab state={state} /></div>
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

function UsersTab({ state }: { state: WatchSyncState }) {
  return <>
    <Section title="Server users" help="Watch sync uses the Plex and Jellyfin servers connected in Settings > Media servers. Discover users to list everyone who can use each server; Plex discovery also refreshes each user's own access token.">
      <p className="radarr-lede">Add, edit, sign in to, and test servers in <Link to="/settings/media-servers">Settings &gt; Media servers</Link>. Both servers must read the same SRTL symlinks; path prefix mappings are set there too.</p>
    </Section>
    {state.servers.map((server) => <ServerUsers key={server.id} server={server} state={state} />)}
  </>;
}

function ServerUsers({ server, state }: { server: MediaServer; state: WatchSyncState }) {
  const setState = useStateUpdate();
  const queryClient = useQueryClient();
  const discover = useMutation({
    mutationFn: () => watchSyncApi.discover(server.id),
    onSuccess: setState,
    // Discovery records the connection status on the shared server either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: mediaServersKey })
  });
  const users = state.users.filter((user) => user.serverId === server.id);
  const kind = mediaServerKindLabels[server.kind];
  const status = mediaServerStatus(server);
  return <section className="radarr-section watch-sync-server" aria-label={`${kind} server ${server.name}`}>
    <div className="radarr-heading">
      <h2>{server.name}<span className="watch-sync-pill">{kind}</span></h2>
      <div className="radarr-toolbar">
        <button type="button" className="secondary" disabled={discover.isPending || !server.hasToken} onClick={() => discover.mutate()}>{discover.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Users size={16} />}Discover users</button>
        <Link to="/settings/media-servers" className="watch-sync-link-button" aria-label={`Edit ${server.name} in Media servers`}><Settings size={16} />Connection</Link>
      </div>
    </div>
    <p className={server.lastError ? "radarr-state error" : "radarr-state"}>
      {server.lastError ?? (server.lastCheckedAt ? `Connected, checked ${formatDate(server.lastCheckedAt)}` : status.label)}
      {server.accountName ? ` · Plex account ${server.accountName}` : ""}
      {` · ${users.length} user${users.length === 1 ? "" : "s"} · ${state.indexedItems[server.id] ?? 0} SRTL items indexed`}
    </p>
    {users.length ? <ul className="watch-sync-users">
      {users.map((user) => <li key={user.externalId} className={user.ready ? undefined : "muted"} title={user.note ?? undefined}>
        <strong>{user.name}</strong>{user.username && user.username !== user.name ? ` (${user.username})` : ""} <span className="watch-sync-pill">{userKindLabels[user.kind]}</span>
        {user.ready ? null : <span className="watch-sync-note"> {user.note ?? "Not available"}</span>}
      </li>)}
    </ul> : <p className="muted">{server.hasToken ? "No users discovered yet." : server.kind === "plex" ? "Sign in with Plex in Settings > Media servers first." : "Add an API key in Settings > Media servers first."}</p>}
    {discover.error ? <p className="error" role="alert">{discover.error.message}</p> : null}
  </section>;
}

function userLabel(state: WatchSyncState, serverId: string, user: WatchSyncUser) {
  const servers = state.servers.filter((server) => server.kind === state.servers.find((entry) => entry.id === serverId)?.kind);
  const server = state.servers.find((entry) => entry.id === serverId);
  return servers.length > 1 && server ? `${user.name} (${server.name})` : user.name;
}

function PairsTab({ state }: { state: WatchSyncState }) {
  const setState = useStateUpdate();
  const plexUsers = state.users.filter((user) => state.servers.some((server) => server.id === user.serverId && server.kind === "plex"));
  const jellyfinUsers = state.users.filter((user) => user.ready && state.servers.some((server) => server.id === user.serverId && server.kind === "jellyfin"));
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
    {state.suggestions.length ? <Section title="Suggested pairs" help="Users whose names match once case, punctuation, and trailing digits are ignored, such as ElJefe_03 and Eljefe. Check each one before pairing.">
      <ul className="watch-sync-suggestions">
        {state.suggestions.map((suggestion) => <li key={`${suggestion.plexServerId}:${suggestion.plexUserId}:${suggestion.jellyfinServerId}`}>
          <span><strong>{suggestion.plexUserName}</strong> (Plex) ↔ <strong>{suggestion.jellyfinUserName}</strong> (Jellyfin){suggestion.match === "similar" ? <span className="watch-sync-pill">similar name</span> : null}</span>
          <button type="button" className="secondary" disabled={add.isPending} onClick={() => add.mutate({ plexServerId: suggestion.plexServerId, plexUserId: suggestion.plexUserId, jellyfinServerId: suggestion.jellyfinServerId, jellyfinUserId: suggestion.jellyfinUserId, direction: "both" })}><Plus size={16} />Pair</button>
        </li>)}
      </ul>
    </Section> : null}
    <Section title="Pair users" help="A Plex user may be paired with several Jellyfin users, and the other way round. Each pair has its own direction.">
      {!plexUsers.length || !jellyfinUsers.length ? <p className="muted">Connect a Plex and a Jellyfin server in <Link to="/settings/media-servers">Settings &gt; Media servers</Link>, then discover their users on the Users tab.</p> : <form className="radarr-toolbar watch-sync-pair-form" onSubmit={submit}>
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
    <p className="muted"><KeyRound size={14} /> Plex tokens and Jellyfin API keys are stored only on the SRTL server, in Settings &gt; Media servers.</p>
  </Section>;
}
