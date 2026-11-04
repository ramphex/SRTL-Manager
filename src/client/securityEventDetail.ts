import type { SecurityEventRecord } from "../shared/auth";

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function eventDetail(event: SecurityEventRecord): string | null {
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
    case "media_server_removed":
      return typeof details.name === "string" ? details.name : null;
    case "account_role_changed":
      return typeof details.target === "string" ? `${details.target}: ${String(details.from)} to ${String(details.to)}` : null;
    case "ownership_transferred":
      return typeof details.target === "string" ? `To ${details.target}` : null;
    case "account_created":
    case "account_disabled":
    case "account_enabled":
    case "account_deleted":
    case "account_password_reset":
      return typeof details.target === "string" ? details.target : null;
    default:
      return null;
  }
}
