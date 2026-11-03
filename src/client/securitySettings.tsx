import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, MonitorSmartphone, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "./api";
import { Panel } from "./App";
import { formatDate, useUserPreferences } from "./appShared";
import { securityEventLabel, type SecurityEventRecord } from "../shared/auth";

const sessionsKey = ["auth-sessions"] as const;
const securityEventsKey = ["security-events"] as const;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function SessionsPanel() {
  const queryClient = useQueryClient();
  const { timeFormat } = useUserPreferences();
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: api.sessions });
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sessionsKey });
    void queryClient.invalidateQueries({ queryKey: securityEventsKey });
  };
  const revoke = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: (result) => {
      if (result.current) {
        // This browser was signed out; return to the sign-in screen.
        void queryClient.invalidateQueries({ queryKey: ["me"] });
        return;
      }
      setMessage("Session signed out.");
      refresh();
    }
  });
  const revokeOthers = useMutation({
    mutationFn: api.revokeOtherSessions,
    onSuccess: (result) => {
      setMessage(result.revoked === 0 ? "No other sessions were signed in." : `Signed out ${plural(result.revoked, "other session")}.`);
      refresh();
    }
  });
  const rows = sessions.data?.sessions ?? [];
  const others = rows.filter((session) => !session.current).length;
  const busy = revoke.isPending || revokeOthers.isPending;
  const error = sessions.error?.message ?? revoke.error?.message ?? revokeOthers.error?.message;

  return (
    <Panel
      title="Sessions"
      icon={<MonitorSmartphone size={18} />}
      actions={
        <button
          type="button"
          className="secondary"
          disabled={busy || sessions.isLoading || others === 0}
          onClick={() => {
            setMessage(null);
            revokeOthers.mutate();
          }}
        >
          <LogOut size={16} />
          Sign out all other sessions
        </button>
      }
    >
      <div className="security-settings">
        <p className="section-settings-help">
          Browsers signed in to this account.
          {typeof sessions.data?.idleTimeoutHours === "number" && typeof sessions.data.maxAgeDays === "number"
            ? ` A session ends after ${plural(sessions.data.idleTimeoutHours, "hour")} without activity and ${plural(sessions.data.maxAgeDays, "day")} after sign-in.`
            : null}{" "}
          Changing the password signs out every session.
        </p>
        {sessions.isLoading ? <p className="panel-message">Loading sessions...</p> : null}
        {rows.length > 0 ? (
          <div className="security-table-scroll" role="region" tabIndex={0} aria-label="Signed-in sessions">
            <table>
              <thead>
                <tr>
                  <th scope="col">Device</th>
                  <th scope="col">Address</th>
                  <th scope="col">Signed in</th>
                  <th scope="col">Last seen</th>
                  <th scope="col">Ends</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <strong>{session.device}</strong>
                      {session.current ? <span className="pill pill-info security-current-pill">This browser</span> : null}
                    </td>
                    <td>{session.ip ?? "-"}</td>
                    <td className="security-nowrap">{formatDate(session.createdAt, timeFormat)}</td>
                    <td className="security-nowrap">{formatDate(session.lastSeenAt, timeFormat)}</td>
                    <td className="security-nowrap">{formatDate(session.expiresAt, timeFormat)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        aria-label={session.current ? "Sign out this browser" : `Sign out ${session.device} at ${session.ip ?? "unknown address"}`}
                        onClick={() => {
                          setMessage(null);
                          revoke.mutate(session.id);
                        }}
                      >
                        <LogOut size={14} />
                        Sign out
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {message ? <p className="success" role="status">{message}</p> : null}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    </Panel>
  );
}

function eventDetail(event: SecurityEventRecord): string | null {
  const details = event.details;
  switch (event.event) {
    case "login_locked":
      return typeof details.retryAfterSeconds === "number" ? `Locked for ${plural(details.retryAfterSeconds, "second")}` : null;
    case "login_succeeded":
      return details.passwordRehashed ? "Password hash upgraded" : null;
    case "username_changed":
      return typeof details.previousUsername === "string" ? `Was ${details.previousUsername}` : null;
    case "password_changed":
      return typeof details.sessionsSignedOut === "number" && details.sessionsSignedOut > 0 ? `${plural(details.sessionsSignedOut, "other session")} signed out` : null;
    case "sessions_revoked":
      return typeof details.count === "number" ? plural(details.count, "session") : null;
    case "session_revoked":
      return details.current ? "This browser" : null;
    case "setup_rejected":
      return details.reason === "token" ? "Wrong setup token" : details.reason === "completed" ? "Setup already completed" : null;
    default:
      return null;
  }
}

const warningEvents = new Set(["login_failed", "login_locked", "setup_rejected", "reauthentication_failed"]);

export function SecurityEventsPanel() {
  const { timeFormat } = useUserPreferences();
  const events = useInfiniteQuery({
    queryKey: securityEventsKey,
    queryFn: ({ pageParam }) => api.securityEvents(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => (page.hasMore ? page.events?.at(-1)?.id : undefined)
  });
  const rows = events.data?.pages.flatMap((page) => page.events ?? []) ?? [];
  const retentionDays = events.data?.pages[0]?.retentionDays;

  return (
    <Panel
      title="Security activity"
      icon={<ShieldCheck size={18} />}
      actions={
        <button type="button" className="secondary" disabled={events.isFetching} onClick={() => void events.refetch()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      }
    >
      <div className="security-settings">
        <p className="section-settings-help">
          Sign-ins, failed attempts, lockouts, setup, account changes, and signed-out sessions, newest first.
          {retentionDays === undefined ? null : retentionDays > 0 ? ` Entries are kept for ${plural(retentionDays, "day")}.` : " Entries are kept until the newest 50,000 remain."}
        </p>
        {events.isLoading ? <p className="panel-message">Loading security activity...</p> : null}
        {events.error ? <p className="error" role="alert">{events.error.message}</p> : null}
        {events.data && rows.length === 0 ? <p className="panel-message">No security activity recorded yet.</p> : null}
        {rows.length > 0 ? (
          <div className="security-table-scroll" role="region" tabIndex={0} aria-label="Security activity">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Username</th>
                  <th scope="col">Address</th>
                  <th scope="col">Device</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => {
                  const detail = eventDetail(event);
                  return (
                    <tr key={event.id}>
                      <td className="security-nowrap">{formatDate(event.createdAt, timeFormat)}</td>
                      <td>
                        <span className={warningEvents.has(event.event) ? "security-event-warning" : undefined}>{securityEventLabel(event.event)}</span>
                        {detail ? <small className="security-event-detail">{detail}</small> : null}
                      </td>
                      <td>{event.username ?? "-"}</td>
                      <td>{event.ip ?? "-"}</td>
                      <td>{event.device ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {events.hasNextPage ? (
          <button type="button" className="secondary security-load-more" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
            {events.isFetchingNextPage ? "Loading..." : "Load older activity"}
          </button>
        ) : null}
      </div>
    </Panel>
  );
}
