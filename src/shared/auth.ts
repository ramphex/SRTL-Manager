import type { AccountRecord, AccountRole } from "./permissions";

/** Minimum length for new and changed passwords. Existing shorter passwords still sign in. */
export const minimumPasswordLength = 12;

/** The setup form's direct address, printed in the server log with the setup token. */
export const setupPagePath = "/setup";

export interface AuthMe {
  authenticated: boolean;
  /** Shown only to clients on this host or the local network; everyone else sees false. */
  setupRequired: boolean;
  user: { id: number; username: string; role: AccountRole; mustChangePassword: boolean } | null;
}

export interface AuthSessionInfo {
  id: number;
  current: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  /** The earlier of the idle deadline and the absolute lifetime. */
  expiresAt: string;
  ip: string | null;
  device: string;
}

export interface AuthSessionList {
  sessions: AuthSessionInfo[];
  idleTimeoutHours: number;
  maxAgeDays: number;
}

export type SecurityEventType =
  | "setup_completed"
  | "setup_rejected"
  | "login_succeeded"
  | "login_failed"
  | "login_locked"
  | "logout"
  | "password_changed"
  | "username_changed"
  | "reauthentication_failed"
  | "session_revoked"
  | "sessions_revoked"
  | "media_server_removed"
  | "stream_stopped"
  | "account_created"
  | "account_role_changed"
  | "account_disabled"
  | "account_enabled"
  | "account_deleted"
  | "account_password_reset"
  | "ownership_transferred";

export interface SecurityEventRecord {
  id: number;
  createdAt: string;
  event: SecurityEventType | string;
  username: string | null;
  ip: string | null;
  device: string | null;
  details: Record<string, unknown>;
}

export interface SecurityEventPage {
  events: SecurityEventRecord[];
  hasMore: boolean;
  retentionDays: number;
}

export interface AccountList {
  accounts: AccountRecord[];
  /** The latest account changes, newest first. */
  activity: SecurityEventRecord[];
}

export const securityEventLabels: Record<SecurityEventType, string> = {
  setup_completed: "Initial setup completed",
  setup_rejected: "Setup attempt rejected",
  login_succeeded: "Signed in",
  login_failed: "Sign-in failed",
  login_locked: "Sign-in temporarily locked",
  logout: "Signed out",
  password_changed: "Password changed",
  username_changed: "Username changed",
  reauthentication_failed: "Wrong current password",
  session_revoked: "Session signed out",
  sessions_revoked: "Other sessions signed out",
  media_server_removed: "Media server removed",
  stream_stopped: "Now Playing stream stopped",
  account_created: "Account created",
  account_role_changed: "Role changed",
  account_disabled: "Account disabled",
  account_enabled: "Account enabled",
  account_deleted: "Account deleted",
  account_password_reset: "Password reset by a manager",
  ownership_transferred: "Ownership transferred"
};

export function securityEventLabel(event: string): string {
  return (securityEventLabels as Record<string, string>)[event] ?? event.replaceAll("_", " ");
}

/** A short, human label such as "Firefox on macOS". Never used for decisions. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg(?:A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent) && /Version\//.test(userAgent)
            ? "Safari"
            : /curl\//i.test(userAgent)
              ? "curl"
              : null;
  const system = /iPhone/.test(userAgent)
    ? "iOS"
    : /iPad/.test(userAgent)
      ? "iPadOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /CrOS/.test(userAgent)
          ? "ChromeOS"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Mac OS X|Macintosh/.test(userAgent)
              ? "macOS"
              : /Linux/.test(userAgent)
                ? "Linux"
                : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}
