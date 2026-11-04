/**
 * The one definition of who may do what. The server enforces it through the
 * route table in `src/server/routeAccess.ts`; the client reads it only to hide
 * controls a person cannot use.
 *
 * To add a role, add it to `accountRoles`, give it a line in each record below
 * (the compiler points at every one), and extend the `admin_users_role_check`
 * database constraint in a new migration.
 */
export const accountRoles = ["owner", "admin", "moderator"] as const;
export type AccountRole = (typeof accountRoles)[number];

export type Permission =
  /** Your own password, username, preferences and sessions. */
  | "account.self"
  /** Library, jobs, logs and Now Playing, with every path root and connection detail removed. */
  | "library.view"
  /** Run scans and audits, retry and cancel their jobs. */
  | "jobs.run"
  /** Copy titles to local storage. Never deletes anything: a file already at the destination is kept under a new name. */
  | "copies.to_local"
  /** Invitations and the people who joined through them. Used by the invitation feature. */
  | "invites.manage"
  /** Purge, delete, orphan cleanup, and anything else that removes files. */
  | "library.delete"
  /** Storage policies and copies to remote storage. */
  | "library.manage"
  /** Stop someone's Now Playing stream. */
  | "streams.stop"
  /** Settings, connections, API keys, paths and backups. Also what lets a response carry them. */
  | "settings.manage"
  /** The security activity and action audit logs. */
  | "activity.view"
  | "moderators.manage"
  | "admins.manage"
  | "ownership.transfer";

const moderatorPermissions: readonly Permission[] = ["account.self", "library.view", "jobs.run", "copies.to_local", "invites.manage"];
const adminPermissions: readonly Permission[] = [...moderatorPermissions, "library.delete", "library.manage", "streams.stop", "settings.manage", "activity.view", "moderators.manage"];
const ownerPermissions: readonly Permission[] = [...adminPermissions, "admins.manage", "ownership.transfer"];

export const rolePermissions: Record<AccountRole, ReadonlySet<Permission>> = {
  owner: new Set(ownerPermissions),
  admin: new Set(adminPermissions),
  moderator: new Set(moderatorPermissions)
};

/** The permission needed to manage an account of a role. The owner is never managed; ownership only moves by transfer. */
const managedBy: Record<AccountRole, Permission | null> = {
  owner: null,
  admin: "admins.manage",
  moderator: "moderators.manage"
};

export const roleLabels: Record<AccountRole, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator"
};

export const roleDescriptions: Record<AccountRole, string> = {
  owner: "Everything, including managing admins and transferring ownership.",
  admin: "Everything except managing admins and transferring ownership.",
  moderator: "Library, jobs and Now Playing: run scans, retry jobs and copy titles to local. No settings, deleting or accounts."
};

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (accountRoles as readonly string[]).includes(value);
}

export function roleHasPermission(role: AccountRole, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}

/** Whether someone with `actor` may grant, edit, reset, disable or delete an account with `target`. */
export function canManageRole(actor: AccountRole, target: AccountRole): boolean {
  const required = managedBy[target];
  return required !== null && roleHasPermission(actor, required);
}

export function manageableRoles(actor: AccountRole): AccountRole[] {
  return accountRoles.filter((role) => canManageRole(actor, role));
}

/** Stopping a to-remote copy undoes work moderators cannot start, and the other job types are cleanups, backups and path moves. */
export function jobStoppableWithoutDeleting(job: { type: string; options?: unknown }): boolean {
  if (job.type === "scan" || job.type === "audit") return true;
  return job.type === "copy" && (job.options as { direction?: unknown } | null | undefined)?.direction === "to_local";
}

export interface AccountRecord {
  id: number;
  username: string;
  role: AccountRole;
  createdAt: string;
  createdBy: string | null;
  disabledAt: string | null;
  disabledBy: string | null;
  mustChangePassword: boolean;
  lastSignInAt: string | null;
  /** Whether the signed-in person may edit this account. */
  manageable: boolean;
  /** The signed-in person's own account. */
  self: boolean;
}
