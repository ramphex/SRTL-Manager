import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, LoaderCircle, LogIn, Pencil, Plug, Plus, Save, Server, Trash2, X } from "lucide-react";
import {
  dupelixOptionalScopes,
  dupelixRequiredScopes,
  mediaServerKindLabels,
  type MediaServer,
  type MediaServerInput,
  type MediaServerKind,
  type MediaServerList,
  type MediaServerPlexPin,
  type MediaServerPrefixMapping
} from "../shared/mediaServers";
import { InfoTooltip } from "./App";
import { formatDate } from "./appShared";
import { mediaServerApi, mediaServersKey, mediaServerStatus, openPlexWindow, pollPlexPin, type PlexWindow } from "./mediaServerApi";

// Watch sync (and later Now Playing and invitations) read these connections, so their views refresh with the list.
function useListUpdate() {
  const queryClient = useQueryClient();
  return useCallback((list: MediaServerList) => {
    queryClient.setQueryData(mediaServersKey, list);
    void queryClient.invalidateQueries({ queryKey: ["watch-sync"] });
  }, [queryClient]);
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: mediaServersKey });
    void queryClient.invalidateQueries({ queryKey: ["watch-sync"] });
  };
}

function Section({ title, help, actions, children }: { title: string; help?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section className="radarr-section">
    <div className="radarr-heading">
      <div className="radarr-help-heading"><h2><Server size={18} />{title}</h2>{help ? <InfoTooltip label={`About ${title}`}>{help}</InfoTooltip> : null}</div>
      {actions ? <div className="radarr-toolbar">{actions}</div> : null}
    </div>
    {children}
  </section>;
}

export function MediaServerSettingsPanel() {
  const query = useQuery({ queryKey: mediaServersKey, queryFn: mediaServerApi.list });
  const [adding, setAdding] = useState<MediaServerKind | null>(null);
  // A Plex server added without a token starts signing in right away; its card picks the sign-in up when it appears.
  const [startedSignIn, setStartedSignIn] = useState<StartedSignIn | null>(null);
  if (query.isLoading) return <p role="status">Loading media servers...</p>;
  if (!query.data) return <p className="error" role="alert">{query.error?.message ?? "Media servers unavailable."}</p>;
  const { servers, limit } = query.data;
  const full = servers.length >= limit;
  return <div className="radarr-settings media-server-settings">
    <Section title="Media servers" help="Plex, Jellyfin, and Dupelix connections that SRTL features share. Watch sync pairs Plex and Jellyfin users; Now Playing shows streams from all three. Plex signs in through plex.tv; Jellyfin and Dupelix use an API key." actions={<>
      <button type="button" className="secondary" disabled={adding !== null || full} onClick={() => setAdding("plex")}><Plus size={16} />Add Plex server</button>
      <button type="button" className="secondary" disabled={adding !== null || full} onClick={() => setAdding("jellyfin")}><Plus size={16} />Add Jellyfin server</button>
      <button type="button" className="secondary" disabled={adding !== null || full} onClick={() => setAdding("dupelix")}><Plus size={16} />Add Dupelix server</button>
    </>}>
      <p className="radarr-lede">Add each server once here; watch sync and other features use the same connection. If a server sees the library under a different folder than SRTL does, add a path prefix mapping, for example <code>/data/media</code> on the server is <code>/mnt/plex</code> in SRTL.</p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {adding ? <ServerForm kind={adding} onDone={() => setAdding(null)} onSignInStarted={setStartedSignIn} /> : null}
      {!servers.length && !adding ? <p className="muted">No media servers yet. Add a Plex, Jellyfin, or Dupelix server to start.</p> : null}
      {full ? <p className="muted">SRTL supports up to {limit} media servers.</p> : null}
    </Section>
    {servers.length ? <div className="media-server-list">{servers.map((server) => <ServerCard key={server.id} server={server} startedSignIn={startedSignIn?.serverId === server.id ? startedSignIn : undefined} onStartedSignInSeen={() => setStartedSignIn(null)} />)}</div> : null}
    <p className="muted"><KeyRound size={14} /> Plex tokens and Jellyfin and Dupelix API keys are stored encrypted on the SRTL server and are never shown again.</p>
  </div>;
}

function PrefixMappings({ value, onChange, disabled }: { value: MediaServerPrefixMapping[]; onChange: (next: MediaServerPrefixMapping[]) => void; disabled?: boolean }) {
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

const namePlaceholders: Record<MediaServerKind, string> = { plex: "Home Plex", jellyfin: "Jellyfin", dupelix: "Dupelix" };
const urlPlaceholders: Record<MediaServerKind, string> = { plex: "http://192.168.1.10:32400", jellyfin: "http://192.168.1.10:8096", dupelix: "https://dupelix.example.com" };
const apiKeyHelp: Record<Exclude<MediaServerKind, "plex">, ReactNode> = {
  jellyfin: <>Create one in Jellyfin under Dashboard &gt; API Keys. It is stored encrypted on the SRTL server and never shown again. Changing the URL requires entering it again.</>,
  dupelix: <>Create a key in Dupelix&apos;s admin settings. It needs <code>activity.read</code> (to list streams) and <code>library.read</code> (for artwork). Optional: <code>activity.stop</code> for the Stop button, <code>activity.network</code> for client addresses, location, and LAN or WAN, and <code>activity.guests</code> for guest profiles. Keys start with <code>msk_</code>. It is stored encrypted on the SRTL server and never shown again. Changing the URL requires entering it again.</>
};

// The key's name, scopes, and expiry as Dupelix last reported them, with the optional scopes it lacks.
function DupelixKeyFacts({ server }: { server: MediaServer }) {
  const [renderedAt] = useState(() => Date.now());
  const key = server.apiKey;
  if (!key) return null;
  const missingRequired = dupelixRequiredScopes.filter((scope) => !key.scopes.includes(scope));
  const missingOptional = dupelixOptionalScopes.filter((entry) => !key.scopes.includes(entry.scope));
  const expired = key.expiresAt !== null && Date.parse(key.expiresAt) <= renderedAt;
  return <>
    <div><dt>API key</dt><dd>{[key.name, key.prefix ? `${key.prefix}…` : null].filter(Boolean).join(" · ") || "Unnamed"}{key.lanOnly ? " · LAN only" : ""}</dd></div>
    <div><dt>Expires</dt><dd className={expired ? "error" : undefined}>{key.expiresAt ? `${expired ? "Expired " : ""}${formatDate(key.expiresAt)}` : "Never"}</dd></div>
    <div><dt>Scopes</dt><dd>{key.scopes.length ? key.scopes.join(", ") : "None"}</dd></div>
    {missingRequired.length ? <div><dt>Missing scopes</dt><dd className="error">{missingRequired.join(", ")}: Now Playing needs {missingRequired.length === 1 ? "it" : "them"}.</dd></div> : null}
    {missingOptional.length ? <div><dt>Optional scopes</dt><dd>Not on this key: {missingOptional.map((entry) => `${entry.scope} (${entry.purpose})`).join(", ")}.</dd></div> : null}
  </>;
}

const plexTokenNote = <>Use the token of the Plex account that owns this server. To find it, open any item in Plex Web, choose <strong>Get Info</strong> &gt; <strong>View XML</strong>, and copy the <code>X-Plex-Token</code> value from the address bar. Never use the <code>PlexOnlineToken</code> from the server&apos;s Preferences.xml.</>;

function ServerFields({ kind, draft, setDraft, hasToken, disabled }: { kind: MediaServerKind; draft: MediaServerInput; setDraft: (draft: MediaServerInput) => void; hasToken: boolean; disabled: boolean }) {
  const tokenId = useId();
  const tokenNoteId = useId();
  const tokenInput = <input id={tokenId} type="password" autoComplete="off" aria-describedby={kind === "plex" ? tokenNoteId : undefined} value={draft.token ?? ""} placeholder={hasToken ? "Saved. Leave empty to keep it." : ""} onChange={(event) => setDraft({ ...draft, token: event.target.value })} />;
  return <fieldset className="radarr-fields" disabled={disabled}>
    <div className="radarr-grid">
      <label>Name<input required maxLength={60} value={draft.name} placeholder={namePlaceholders[kind]} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>Server URL<input required value={draft.url} placeholder={urlPlaceholders[kind]} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
    </div>
    {kind === "plex" ? <details className="radarr-setup media-server-manual-token">
      <summary>Or enter a token manually</summary>
      <div className="radarr-field">
        <label htmlFor={tokenId}>Plex token</label>
        {tokenInput}
        <p id={tokenNoteId} className="muted">{plexTokenNote}</p>
      </div>
    </details> : <div className="radarr-field">
      <div className="radarr-field-label"><label htmlFor={tokenId}>API key</label><InfoTooltip label="About the API key">{apiKeyHelp[kind]}</InfoTooltip></div>
      {tokenInput}
      {kind === "dupelix" ? <p className="muted">Needs the <code>activity.read</code> and <code>library.read</code> scopes. Add <code>activity.stop</code>, <code>activity.network</code>, and <code>activity.guests</code> for Stop, client addresses, and guest profiles.</p> : null}
    </div>}
    <PrefixMappings value={draft.prefixMappings} onChange={(prefixMappings) => setDraft({ ...draft, prefixMappings })} />
  </fieldset>;
}

function cleanMappings(draft: MediaServerInput): MediaServerInput {
  return { ...draft, prefixMappings: draft.prefixMappings.filter((mapping) => mapping.serverPrefix.trim() || mapping.srtlPrefix.trim()) };
}

// A sign-in the add form started, or the reason it could not start, for the new server's card to show.
interface StartedSignIn { serverId: string; pin?: MediaServerPlexPin; error?: string }

const errorText = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function ServerForm({ kind, onDone, onSignInStarted }: { kind: MediaServerKind; onDone: () => void; onSignInStarted: (signIn: StartedSignIn) => void }) {
  const setList = useListUpdate();
  const [draft, setDraft] = useState<MediaServerInput>({ name: "", url: "", token: "", prefixMappings: [] });
  // Plex connects through plex.tv unless a token was pasted under "Or enter a token manually".
  const signIn = kind === "plex" && !draft.token?.trim();
  const add = useMutation({
    mutationFn: async (plexWindow: PlexWindow | null) => {
      const input = cleanMappings(draft);
      const list = await mediaServerApi.add(kind, input);
      if (!plexWindow) return { list };
      // Names are unique, so the new server is the one with this name.
      const server = list.servers.find((entry) => entry.kind === "plex" && entry.name.toLowerCase() === input.name.trim().toLowerCase());
      if (!server) { plexWindow.close(); return { list }; }
      try {
        const pin = await mediaServerApi.startPin(server.id);
        plexWindow.show(pin.authUrl);
        return { list, started: { serverId: server.id, pin } };
      } catch (error) {
        plexWindow.close();
        return { list, started: { serverId: server.id, error: errorText(error, "Sign in with Plex could not start.") } };
      }
    },
    onSuccess: ({ list, started }) => {
      if (started) onSignInStarted(started);
      setList(list);
      onDone();
    },
    onError: (_error, plexWindow) => plexWindow?.close()
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (add.isPending) return;
    add.mutate(signIn ? openPlexWindow() : null);
  };
  return <form className="watch-sync-card" aria-label={`Add ${mediaServerKindLabels[kind]} server`} onSubmit={submit}>
    <h3>Add a {mediaServerKindLabels[kind]} server</h3>
    {kind === "plex"
      ? <p className="muted">Sign in with Plex to connect automatically. SRTL gets the token from plex.tv for you.</p>
      : kind === "dupelix"
        ? <p className="muted">Enter the server&apos;s address and a Dupelix API key with the <code>activity.read</code> and <code>library.read</code> scopes, plus <code>activity.stop</code>, <code>activity.network</code>, or <code>activity.guests</code> if you want Stop, client addresses, or guest profiles. Dupelix streams appear in Now Playing; watch sync does not use Dupelix yet.</p>
        : <p className="muted">Enter the server&apos;s address and an API key from Jellyfin&apos;s Dashboard &gt; API Keys.</p>}
    <ServerFields kind={kind} draft={draft} setDraft={setDraft} hasToken={false} disabled={add.isPending} />
    <div className="radarr-toolbar">
      <button type="submit" disabled={add.isPending || !draft.name.trim() || !draft.url.trim()}>{add.isPending ? <LoaderCircle size={16} className="spin-icon" /> : signIn ? <LogIn size={16} /> : <Check size={16} />}{signIn ? "Add and sign in with Plex" : "Add server"}</button>
      <button type="button" className="secondary" disabled={add.isPending} onClick={onDone}><X size={16} />Cancel</button>
    </div>
    {signIn ? <p className="muted">A plex.tv window opens. Approve SRTL there as the account that owns this server, then come back here.</p> : null}
    {add.error ? <p className="error" role="alert">{add.error.message}</p> : null}
  </form>;
}

function PlexSignIn({ server, started, onStartedSeen }: { server: MediaServer; started?: StartedSignIn; onStartedSeen?: () => void }) {
  const setList = useListUpdate();
  const [pin, setPin] = useState<MediaServerPlexPin | null>(started?.pin ?? null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(started?.error ? { text: started.error, ok: false } : null);
  // The add form's sign-in is taken over once; later renders of this card start their own.
  useEffect(() => { if (started) onStartedSeen?.(); }, [started, onStartedSeen]);
  const start = useMutation({
    mutationFn: async (plexWindow: PlexWindow) => {
      try {
        const created = await mediaServerApi.startPin(server.id);
        plexWindow.show(created.authUrl);
        return created;
      } catch (error) {
        plexWindow.close();
        throw error;
      }
    },
    onSuccess: (created) => {
      setPin(created);
      setMessage(null);
    }
  });
  useEffect(() => {
    if (!pin) return undefined;
    return pollPlexPin(() => mediaServerApi.checkPin(server.id, pin.pinId), (update) => {
      if ("error" in update) {
        setPin(null);
        setMessage({ text: errorText(update.error, "Sign in with Plex failed. Select Sign in with Plex to try again."), ok: false });
      } else if (update.status.status === "authorized") {
        if (update.status.servers) setList(update.status.servers);
        setPin(null);
        setMessage({ text: "Signed in with Plex.", ok: true });
      } else if (update.status.status === "expired") {
        setPin(null);
        setMessage({ text: "The Plex sign-in expired before it was approved. Select Sign in with Plex to start again.", ok: false });
      }
    });
  }, [pin, server.id, setList]);
  const reconnect = server.hasToken;
  const hintId = useId();
  return <div className="watch-sync-signin">
    <button type="button" className={reconnect ? "secondary" : undefined} aria-describedby={hintId} disabled={start.isPending || Boolean(pin)} onClick={() => { start.reset(); start.mutate(openPlexWindow()); }}>{pin || start.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <LogIn size={16} />}{reconnect ? "Sign in with Plex again" : "Sign in with Plex"}</button>
    <p id={hintId} className="muted">{reconnect
      ? "Reconnects this server through plex.tv, for example after a Plex password change or when the connection stops working."
      : "Not connected yet. Sign in with Plex to connect automatically. SRTL gets the token from plex.tv for you."}</p>
    {pin ? <p className="muted" role="status">Waiting for plex.tv. Approve the sign-in in the window that opened, or <a href={pin.authUrl} target="_blank" rel="noopener noreferrer">open it here</a> (code {pin.code}).</p> : null}
    {message ? <p className={message.ok ? "success" : "error"} role="status">{message.text}</p> : null}
    {start.error ? <p className="error" role="alert">{start.error.message}</p> : null}
  </div>;
}

function ServerCard({ server, startedSignIn, onStartedSignInSeen }: { server: MediaServer; startedSignIn?: StartedSignIn; onStartedSignInSeen?: () => void }) {
  const setList = useListUpdate();
  const refresh = useRefresh();
  const initialDraft = (): MediaServerInput => ({ name: server.name, url: server.url, token: "", prefixMappings: server.prefixMappings });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MediaServerInput>(initialDraft);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useMutation({ mutationFn: () => mediaServerApi.update(server.id, cleanMappings(draft)), onSuccess: (list) => { setList(list); setEditing(false); } });
  // A failed test still records the error on the server, so the list is refreshed either way.
  const test = useMutation({ mutationFn: () => mediaServerApi.test(server.id), onSuccess: setList, onError: refresh });
  const remove = useMutation({ mutationFn: () => mediaServerApi.remove(server.id), onSuccess: setList });
  const busy = save.isPending || test.isPending || remove.isPending;
  const changed = draft.name !== server.name || draft.url !== server.url || Boolean(draft.token) || JSON.stringify(draft.prefixMappings) !== JSON.stringify(server.prefixMappings);
  const addressChanged = draft.url.trim().replace(/\/+$/, "") !== server.url;
  const status = mediaServerStatus(server);
  const kind = mediaServerKindLabels[server.kind];
  return <section className="watch-sync-card media-server-card" aria-label={`${kind} server ${server.name}`}>
    <div className="radarr-heading">
      <h3>{server.name}<span className="watch-sync-pill">{kind}</span></h3>
      <span className={`radarr-instance-status radarr-instance-status-${status.kind}`}>{status.label}</span>
    </div>
    <dl className="media-server-facts">
      <div><dt>URL</dt><dd className="radarr-path">{server.url}</dd></div>
      <div><dt>Version</dt><dd>{server.version ? `${kind} ${server.version}` : "Unknown"}</dd></div>
      <div><dt>Status</dt><dd className={server.lastError ? "error" : undefined}>{server.lastError ?? (server.lastCheckedAt ? `Connected, checked ${formatDate(server.lastCheckedAt)}` : server.hasToken ? "Not checked yet" : status.label)}</dd></div>
      {server.accountName ? <div><dt>Plex account</dt><dd>{server.accountName}</dd></div> : null}
      {server.kind === "dupelix" ? <DupelixKeyFacts server={server} /> : null}
      {server.prefixMappings.length ? <div><dt>Path mappings</dt><dd>{server.prefixMappings.map((mapping) => `${mapping.serverPrefix} → ${mapping.srtlPrefix}`).join(", ")}</dd></div> : null}
    </dl>
    <div className="radarr-toolbar">
      <button type="button" className="secondary" disabled={busy || !server.hasToken} onClick={() => test.mutate()} title={server.hasToken ? undefined : server.kind === "plex" ? "Sign in with Plex first" : "Enter an API key first"}>{test.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Plug size={16} />}Test connection</button>
      <button type="button" className="secondary" disabled={busy} aria-expanded={editing} onClick={() => { setDraft(initialDraft()); setEditing(!editing); }}><Pencil size={16} />Edit</button>
      <button type="button" className="secondary icon-only" aria-label={`Remove ${server.name}`} disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} /></button>
    </div>
    {test.isSuccess && !server.lastError ? <p className="success" role="status">Connected{server.version ? ` to ${kind} ${server.version}` : ""}.</p> : null}
    {server.kind === "plex" ? <PlexSignIn server={server} started={startedSignIn} onStartedSeen={onStartedSignInSeen} /> : null}
    {editing ? <form className="media-server-edit" aria-label={`Edit ${server.name}`} onSubmit={(event) => { event.preventDefault(); if (!busy) save.mutate(); }}>
      <ServerFields kind={server.kind} draft={draft} setDraft={setDraft} hasToken={server.hasToken} disabled={busy} />
      {server.kind === "plex" && server.hasToken && addressChanged && !draft.token?.trim() ? <p className="muted" role="note">Saving a new address signs this server out of Plex, so its token is never sent to the new address. Use <strong>Sign in with Plex</strong> afterwards, or enter a token manually above.</p> : null}
      <div className="radarr-toolbar">
        <button type="submit" disabled={busy || !changed}>{save.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Save size={16} />}Save</button>
        <button type="button" className="secondary" disabled={save.isPending} onClick={() => setEditing(false)}><X size={16} />Cancel</button>
      </div>
    </form> : null}
    {confirmRemove ? <div className="radarr-confirmation" role="group" aria-label={`Confirm removing ${server.name}`}>
      <p>Remove {server.name}? SRTL forgets this connection and the users and item index it kept for it. Nothing changes on the server. Servers that watch sync pairs still use cannot be removed.</p>
      <div className="radarr-toolbar">
        <button type="button" className="danger" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={16} />Remove</button>
        <button type="button" className="secondary" onClick={() => { setConfirmRemove(false); remove.reset(); }}>Cancel</button>
      </div>
    </div> : null}
    {[save.error, test.error, remove.error].map((error, index) => error ? <p key={index} className="error" role="alert">{error.message}</p> : null)}
  </section>;
}
