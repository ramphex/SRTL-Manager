import { EventEmitter } from "node:events";
import { asc, eq, sql } from "drizzle-orm";
import { accountRole, passwordHashing, type AdminUser } from "./auth";
import { accountsLockKey } from "./db/accountsMigration";
import { first, nowIso, type Db } from "./db/database";
import * as schema from "./db/schema";
import { AppError, ConflictError } from "./errors";
import { canManageRole, roleHasPermission, roleLabels, type AccountRecord, type AccountRole } from "../shared/permissions";

/**
 * Every account change happens here, one at a time under one lock, against the
 * actor and target as they are inside that lock rather than as the request
 * first saw them. So someone demoted a moment ago cannot finish a change they
 * have just lost the right to make, and concurrent transfers cannot overlap.
 */

export class AccountForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that.") {
    super(message, 403, { code: "forbidden" });
  }
}

/** Lets open streams end as soon as an account changes; ordinary requests read the account every time anyway. */
const accountChanges = new EventEmitter();
accountChanges.setMaxListeners(0);

function notifyAccountChanged(userId: number): void {
  accountChanges.emit("changed", userId);
}

export function onAccountChanged(listener: (userId: number) => void): () => void {
  accountChanges.on("changed", listener);
  return () => accountChanges.off("changed", listener);
}

type Transaction = Db;

function withAccountsLock<T>(db: Db, work: (transaction: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${accountsLockKey})`);
    return work(transaction);
  });
}

function lockedAccount(transaction: Transaction, id: number): Promise<AdminUser | undefined> {
  return first(transaction.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, id)).for("update").limit(1));
}

async function currentActor(transaction: Transaction, actorId: number): Promise<AdminUser> {
  const actor = await lockedAccount(transaction, actorId);
  if (!actor || actor.disabledAt) throw new AccountForbiddenError();
  return actor;
}

async function manageableTarget(transaction: Transaction, actor: AdminUser, targetId: number): Promise<AdminUser> {
  if (actor.id === targetId) throw new AccountForbiddenError("You cannot change your own role or access here. Use User settings for your own password.");
  const target = await lockedAccount(transaction, targetId);
  if (!target) throw new AppError("Account not found", 404);
  if (!canManageRole(accountRole(actor), accountRole(target))) throw new AccountForbiddenError(`You cannot manage ${roleLabels[accountRole(target)].toLowerCase()} accounts.`);
  return target;
}

async function deleteSessions(transaction: Transaction, userId: number): Promise<number> {
  return (await transaction.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).returning({ id: schema.sessions.id })).length;
}

export async function listAccounts(db: Db, actorId: number, actorRole: AccountRole): Promise<AccountRecord[]> {
  const rows = await db.select().from(schema.adminUsers).orderBy(asc(schema.adminUsers.id));
  return rows.map((row) => toAccountRecord(row, actorId, actorRole));
}

function toAccountRecord(row: AdminUser, actorId: number, actorRole: AccountRole): AccountRecord {
  const role = accountRole(row);
  return {
    id: row.id,
    username: row.username,
    role,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    disabledAt: row.disabledAt,
    disabledBy: row.disabledBy,
    mustChangePassword: row.mustChangePassword,
    lastSignInAt: row.lastSignInAt,
    manageable: row.id !== actorId && canManageRole(actorRole, role),
    self: row.id === actorId
  };
}

export interface NewAccount {
  username: string;
  role: AccountRole;
  temporaryPassword: string;
}

export async function createAccount(db: Db, actorId: number, input: NewAccount): Promise<AccountRecord> {
  const passwordHash = await passwordHashing.hash(input.temporaryPassword);
  return withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    if (!canManageRole(accountRole(actor), input.role)) throw new AccountForbiddenError(`You cannot create ${roleLabels[input.role].toLowerCase()} accounts.`);
    const username = input.username.trim();
    const taken = await first(transaction.select({ id: schema.adminUsers.id }).from(schema.adminUsers).where(sql`lower(${schema.adminUsers.username}) = lower(${username})`).limit(1));
    if (taken) throw new ConflictError("Username is already in use");
    const [row] = await transaction
      .insert(schema.adminUsers)
      .values({ username, passwordHash, role: input.role, mustChangePassword: true, createdAt: nowIso(), createdBy: actor.username })
      .returning();
    if (!row) throw new Error("Account could not be created");
    return toAccountRecord(row, actorId, accountRole(actor));
  });
}

export interface AccountChange {
  username: string;
  sessionsEnded: number;
  from?: AccountRole;
  to?: AccountRole;
  changed: boolean;
}

export async function changeAccountRole(db: Db, actorId: number, targetId: number, role: AccountRole): Promise<AccountChange> {
  const change = await withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    const target = await manageableTarget(transaction, actor, targetId);
    if (!canManageRole(accountRole(actor), role)) throw new AccountForbiddenError(`You cannot grant the ${roleLabels[role].toLowerCase()} role.`);
    const from = accountRole(target);
    if (from !== role) await transaction.update(schema.adminUsers).set({ role }).where(eq(schema.adminUsers.id, targetId));
    return { username: target.username, sessionsEnded: 0, from, to: role, changed: from !== role };
  });
  notifyAccountChanged(targetId);
  return change;
}

export async function setAccountDisabled(db: Db, actorId: number, targetId: number, disabled: boolean): Promise<AccountChange> {
  const change = await withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    const target = await manageableTarget(transaction, actor, targetId);
    const changed = Boolean(target.disabledAt) !== disabled;
    if (changed) {
      await transaction
        .update(schema.adminUsers)
        .set(disabled ? { disabledAt: nowIso(), disabledBy: actor.username } : { disabledAt: null, disabledBy: null })
        .where(eq(schema.adminUsers.id, targetId));
    }
    return { username: target.username, sessionsEnded: disabled ? await deleteSessions(transaction, targetId) : 0, changed };
  });
  notifyAccountChanged(targetId);
  return change;
}

export async function deleteAccount(db: Db, actorId: number, targetId: number): Promise<AccountChange> {
  const change = await withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    const target = await manageableTarget(transaction, actor, targetId);
    const sessionsEnded = await deleteSessions(transaction, targetId);
    await transaction.delete(schema.appSettings).where(eq(schema.appSettings.key, userPreferencesKey(targetId)));
    await transaction.delete(schema.adminUsers).where(eq(schema.adminUsers.id, targetId));
    return { username: target.username, sessionsEnded, from: accountRole(target), changed: true };
  });
  notifyAccountChanged(targetId);
  return change;
}

/** Sets a temporary password chosen by a manager. It must be changed at the next sign-in, and every session ends now. */
export async function resetAccountPassword(db: Db, actorId: number, targetId: number, temporaryPassword: string): Promise<AccountChange> {
  const passwordHash = await passwordHashing.hash(temporaryPassword);
  const change = await withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    const target = await manageableTarget(transaction, actor, targetId);
    await transaction.update(schema.adminUsers).set({ passwordHash, mustChangePassword: true }).where(eq(schema.adminUsers.id, targetId));
    return { username: target.username, sessionsEnded: await deleteSessions(transaction, targetId), changed: true };
  });
  notifyAccountChanged(targetId);
  return change;
}

export class WrongPasswordError extends AppError {
  constructor() {
    super("Current password is incorrect", 401, { code: "wrong_password" });
  }
}

export interface OwnershipTransfer {
  previousOwner: string;
  newOwner: string;
}

/**
 * Moves ownership after re-checking the owner's password, leaving them an
 * admin. The password check runs before the lock so its cost is not paid while
 * holding it. Inside the lock the caller must still be the owner, so of two
 * concurrent transfers the second is refused.
 */
export async function transferOwnership(db: Db, actorId: number, targetId: number, currentPassword: string): Promise<OwnershipTransfer> {
  const before = await first(db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, actorId)).limit(1));
  if (!before || !roleHasPermission(accountRole(before), "ownership.transfer")) throw new AccountForbiddenError();
  if (!(await passwordHashing.verify(currentPassword, before.passwordHash))) throw new WrongPasswordError();
  const transfer = await withAccountsLock(db, async (transaction) => {
    const actor = await currentActor(transaction, actorId);
    if (!roleHasPermission(accountRole(actor), "ownership.transfer") || actor.passwordHash !== before.passwordHash) throw new AccountForbiddenError();
    if (actorId === targetId) throw new AppError("You already own this instance.", 400);
    const target = await lockedAccount(transaction, targetId);
    if (!target) throw new AppError("Account not found", 404);
    if (target.disabledAt) throw new ConflictError("Enable this account before transferring ownership to it.");
    if (target.mustChangePassword) throw new ConflictError("This account must sign in and replace its temporary password before it can become the owner.");
    // Demote first: the unique index allows only one owner at any moment, and the commit check requires one at the end.
    await transaction.update(schema.adminUsers).set({ role: "admin" }).where(eq(schema.adminUsers.id, actorId));
    await transaction.update(schema.adminUsers).set({ role: "owner" }).where(eq(schema.adminUsers.id, targetId));
    return { previousOwner: actor.username, newOwner: target.username };
  });
  notifyAccountChanged(actorId);
  notifyAccountChanged(targetId);
  return transfer;
}

/** Each account's own display preferences; accounts without any yet read the instance-wide ones saved before accounts existed. */
export function userPreferencesKey(userId: number): string {
  return `userPreferences:${userId}`;
}
