import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, LoaderCircle, LogIn, Pencil, Plug, Plus, Save, Server, Trash2, X } from "lucide-react";
import {
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
import { mediaServerApi, mediaServersKey, mediaServerStatus } from "./mediaServerApi";

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
  if (query.isLoading) return <p role="status">Loading media servers...</p>;
  if (!query.data) return <p className="error" role="alert">{query.error?.message ?? "Media servers unavailable."}</p>;
  const { servers, limit } = query.data;
  const full = servers.length >= limit;
  return <div className="radarr-settings media-server-settings">
    <Section title="Media servers" help="Plex and Jellyfin connections that SRTL features share. Watch sync pairs users across them. Plex signs in through plex.tv; Jellyfin uses an API key from Dashboard > API Keys." actions={<>
      <button type="button" className="secondary" disabled={adding !== null || full} onClick={() => setAdding("plex")}><Plus size={16} />Add Plex server</button>
      <button type="button" className="secondary" disabled={adding !== null || full} onClick={() => setAdding("jellyfin")}><Plus size={16} />Add Jellyfin server</button>
    </>}>
      <p className="radarr-lede">Add each server once here; watch sync and other features use the same connection. If a server sees the library under a different folder than SRTL does, add a path prefix mapping, for example <code>/data/media</code> on the server is <code>/mnt/plex</code> in SRTL.</p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {adding ? <ServerForm kind={adding} onDone={() => setAdding(null)} /> : null}
      {!servers.length && !adding ? <p className="muted">No media servers yet. Add a Plex or Jellyfin server to start.</p> : null}
      {full ? <p className="muted">SRTL supports up to {limit} media servers.</p> : null}
    </Section>
    {servers.length ? <div className="media-server-list">{servers.map((server) => <ServerCard key={server.id} server={server} />)}</div> : null}
    <p className="muted"><KeyRound size={14} /> Plex tokens and Jellyfin API keys are stored encrypted on the SRTL server and are never shown again.</p>
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

function ServerFields({ kind, draft, setDraft, hasToken, disabled }: { kind: MediaServerKind; draft: MediaServerInput; setDraft: (draft: MediaServerInput) => void; hasToken: boolean; disabled: boolean }) {
  const tokenId = useId();
  const tokenLabel = kind === "plex" ? "Plex token (optional)" : "API key";
  const tokenHelp = kind === "plex"
    ? "Use Sign in with Plex instead when you can. If you paste a token, use your account's token, never the PlexOnlineToken from the server's Preferences.xml."
    : "Create one in Jellyfin under Dashboard > API Keys. It is stored encrypted on the SRTL server and never shown again. Changing the URL requires entering it again.";
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

function cleanMappings(draft: MediaServerInput): MediaServerInput {
  return { ...draft, prefixMappings: draft.prefixMappings.filter((mapping) => mapping.serverPrefix.trim() || mapping.srtlPrefix.trim()) };
}

function ServerForm({ kind, onDone }: { kind: MediaServerKind; onDone: () => void }) {
  const setList = useListUpdate();
  const [draft, setDraft] = useState<MediaServerInput>({ name: "", url: "", token: "", prefixMappings: [] });
  const add = useMutation({ mutationFn: () => mediaServerApi.add(kind, cleanMappings(draft)), onSuccess: (list) => { setList(list); onDone(); } });
  const submit = (event: FormEvent) => { event.preventDefault(); if (!add.isPending) add.mutate(); };
  return <form className="watch-sync-card" aria-label={`Add ${mediaServerKindLabels[kind]} server`} onSubmit={submit}>
    <h3>Add a {mediaServerKindLabels[kind]} server</h3>
    <ServerFields kind={kind} draft={draft} setDraft={setDraft} hasToken={false} disabled={add.isPending} />
    {kind === "plex" ? <p className="muted">After adding it, use <strong>Sign in with Plex</strong> to connect as the server owner.</p> : null}
    <div className="radarr-toolbar">
      <button type="submit" disabled={add.isPending || !draft.name.trim() || !draft.url.trim()}>{add.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Check size={16} />}Add server</button>
      <button type="button" className="secondary" disabled={add.isPending} onClick={onDone}><X size={16} />Cancel</button>
    </div>
    {add.error ? <p className="error" role="alert">{add.error.message}</p> : null}
  </form>;
}

function PlexSignIn({ server }: { server: MediaServer }) {
  const setList = useListUpdate();
  const [pin, setPin] = useState<MediaServerPlexPin | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => mediaServerApi.startPin(server.id),
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
      mediaServerApi.checkPin(server.id, pin.pinId).then((status) => {
        if (stopped) return;
        if (status.status === "authorized") {
          if (status.servers) setList(status.servers);
          setPin(null);
          setMessage("Signed in with Plex.");
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
  }, [pin, server.id, setList]);
  return <div className="watch-sync-signin">
    <button type="button" disabled={start.isPending || Boolean(pin)} onClick={() => start.mutate()}>{pin ? <LoaderCircle size={16} className="spin-icon" /> : <LogIn size={16} />}{server.hasToken ? "Sign in with Plex again" : "Sign in with Plex"}</button>
    {pin ? <p className="muted" role="status">Waiting for plex.tv. Approve the sign-in in the window that opened, or <a href={pin.authUrl} target="_blank" rel="noopener noreferrer">open it here</a> (code {pin.code}).</p> : null}
    {message ? <p className={message.startsWith("Signed in") ? "success" : "error"} role="status">{message}</p> : null}
    {start.error ? <p className="error" role="alert">{start.error.message}</p> : null}
  </div>;
}

function ServerCard({ server }: { server: MediaServer }) {
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
      {server.prefixMappings.length ? <div><dt>Path mappings</dt><dd>{server.prefixMappings.map((mapping) => `${mapping.serverPrefix} → ${mapping.srtlPrefix}`).join(", ")}</dd></div> : null}
    </dl>
    <div className="radarr-toolbar">
      <button type="button" className="secondary" disabled={busy || !server.hasToken} onClick={() => test.mutate()} title={server.hasToken ? undefined : server.kind === "plex" ? "Sign in with Plex first" : "Enter an API key first"}>{test.isPending ? <LoaderCircle size={16} className="spin-icon" /> : <Plug size={16} />}Test connection</button>
      <button type="button" className="secondary" disabled={busy} aria-expanded={editing} onClick={() => { setDraft(initialDraft()); setEditing(!editing); }}><Pencil size={16} />Edit</button>
      <button type="button" className="secondary icon-only" aria-label={`Remove ${server.name}`} disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} /></button>
    </div>
    {test.isSuccess && !server.lastError ? <p className="success" role="status">Connected{server.version ? ` to ${kind} ${server.version}` : ""}.</p> : null}
    {server.kind === "plex" ? <PlexSignIn server={server} /> : null}
    {editing ? <form className="media-server-edit" aria-label={`Edit ${server.name}`} onSubmit={(event) => { event.preventDefault(); if (!busy) save.mutate(); }}>
      <ServerFields kind={server.kind} draft={draft} setDraft={setDraft} hasToken={server.hasToken} disabled={busy} />
      {server.kind === "plex" && server.hasToken && addressChanged && !draft.token?.trim() ? <p className="muted" role="note">Saving a new address signs this server out of Plex, so its token is never sent to the new address. Use <strong>Sign in with Plex</strong> again afterwards, or paste a token above.</p> : null}
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
