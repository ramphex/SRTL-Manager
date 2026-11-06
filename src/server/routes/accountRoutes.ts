import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { changeAccountRole, createAccount, deleteAccount, listAccounts, resetAccountPassword, setAccountDisabled, transferOwnership, WrongPasswordError } from "../accounts";
import type { Db } from "../db/database";
import { AppError } from "../errors";
import { recordActionAudit } from "../lib/actionAudit";
import { LoginThrottle } from "../loginThrottle";
import { listSecurityEvents, recordSecurityEvent } from "../securityEvents";
import { minimumPasswordLength, type AccountList } from "../../shared/auth";
import { accountRoles, roleLabels } from "../../shared/permissions";

const accountEvents = ["account_created", "account_role_changed", "account_disabled", "account_enabled", "account_deleted", "account_password_reset", "ownership_transferred"];

const idParams = z.object({ id: z.coerce.number().int().positive() });
const roleSchema = z.enum(accountRoles, { error: "Choose a role" });
const usernameSchema = z.string({ error: "Username is required" }).trim().min(1, "Username is required").max(100, "Username must be 100 characters or fewer");
const temporaryPasswordSchema = z
  .string({ error: "Temporary password is required" })
  .min(minimumPasswordLength, `Temporary password must be at least ${minimumPasswordLength} characters`)
  .max(256, "Temporary password must be 256 characters or fewer");
const accountChangeLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export interface AccountRouteOptions {
  throttle: LoginThrottle;
}

export function registerAccountRoutes(app: FastifyInstance, db: Db, options: AccountRouteOptions): void {
  const actorId = (request: FastifyRequest): number => {
    if (!request.adminSession) throw new AppError("Authentication required", 401);
    return request.adminSession.userId;
  };

  app.get("/api/accounts", async (request): Promise<AccountList> => {
    const session = request.adminSession;
    if (!session) throw new AppError("Authentication required", 401);
    const [accounts, activity] = await Promise.all([listAccounts(db, session.userId, session.role), listSecurityEvents(db, { limit: 25, events: accountEvents })]);
    return { accounts, activity: activity.events };
  });

  app.post("/api/accounts", { config: accountChangeLimit }, async (request, reply) => {
    const body = z.object({ username: usernameSchema, role: roleSchema, temporaryPassword: temporaryPasswordSchema }).parse(request.body);
    const account = await createAccount(db, actorId(request), body);
    await recordActionAudit(db, request, {
      action: "account.create",
      summary: `Created ${roleLabels[account.role].toLowerCase()} account "${account.username}"`,
      targets: { targetId: account.id, target: account.username, role: account.role }
    });
    return reply.code(201).send(account);
  });

  app.put("/api/accounts/:id/role", { config: accountChangeLimit }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { role } = z.object({ role: roleSchema }).parse(request.body);
    const change = await changeAccountRole(db, actorId(request), id, role);
    if (change.changed) {
      await recordActionAudit(db, request, {
        action: "account.role_change",
        summary: `Changed "${change.username}" from ${change.from} to ${change.to}`,
        targets: { targetId: id, target: change.username, from: change.from, to: change.to }
      });
    }
    return { ok: true };
  });

  for (const disabled of [true, false]) {
    app.post(`/api/accounts/:id/${disabled ? "disable" : "enable"}`, { config: accountChangeLimit }, async (request) => {
      const { id } = idParams.parse(request.params);
      const change = await setAccountDisabled(db, actorId(request), id, disabled);
      if (change.changed) {
        await recordActionAudit(db, request, {
          action: disabled ? "account.disable" : "account.enable",
          summary: `${disabled ? "Disabled" : "Enabled"} "${change.username}"`,
          targets: { targetId: id, target: change.username, sessionsEnded: change.sessionsEnded }
        });
      }
      return { ok: true };
    });
  }

  app.delete("/api/accounts/:id", { config: accountChangeLimit }, async (request) => {
    const { id } = idParams.parse(request.params);
    const change = await deleteAccount(db, actorId(request), id);
    await recordActionAudit(db, request, {
      action: "account.delete",
      summary: `Deleted ${change.from} account "${change.username}"`,
      targets: { targetId: id, target: change.username, role: change.from, sessionsEnded: change.sessionsEnded }
    });
    return { ok: true };
  });

  app.post("/api/accounts/:id/reset-password", { config: accountChangeLimit }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { temporaryPassword } = z.object({ temporaryPassword: temporaryPasswordSchema }).parse(request.body);
    const change = await resetAccountPassword(db, actorId(request), id, temporaryPassword);
    // Whoever was locked out can sign in with the new password straight away.
    options.throttle.usernames.reset(LoginThrottle.usernameKey(change.username));
    await recordActionAudit(db, request, {
      action: "account.password_reset",
      summary: `Reset the password of "${change.username}"`,
      targets: { targetId: id, target: change.username, sessionsEnded: change.sessionsEnded }
    });
    return { ok: true };
  });

  app.post("/api/accounts/transfer-ownership", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({ targetId: z.number({ error: "Choose an account" }).int().positive(), currentPassword: z.string({ error: "Current password is required" }).min(1, "Current password is required").max(256) }).parse(request.body);
    const session = request.adminSession;
    if (!session) throw new AppError("Authentication required", 401);
    try {
      const transfer = await transferOwnership(db, session.userId, body.targetId, body.currentPassword);
      await recordActionAudit(db, request, {
        action: "account.ownership_transfer",
        summary: `Transferred ownership from "${transfer.previousOwner}" to "${transfer.newOwner}"`,
        targets: { targetId: body.targetId, target: transfer.newOwner, from: transfer.previousOwner }
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof WrongPasswordError) {
        await recordSecurityEvent(db, { event: "reauthentication_failed", request, userId: session.userId, username: session.username, sessionId: session.id, details: { action: "transfer_ownership" } });
        return reply.code(401).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
