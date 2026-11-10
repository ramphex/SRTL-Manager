import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import {
  authenticate,
  createOwner,
  createSession,
  createSessionForSignIn,
  deleteSession,
  findAdminByUsername,
  hasOwner,
  insertSession,
  passwordHashing,
  rehashIfNeeded,
  revokeAllUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
  listUserSessions,
  sessionDeadline,
  SetupUnavailableError,
  SignInLockedError,
  type ActiveSession
} from "../auth";
import { first, type Db } from "../db/database";
import { AppError } from "../errors";
import * as schema from "../db/schema";
import { markOnboardingAccountCreated } from "../lib/onboarding";
import { ConcurrencyGate, LoginThrottle } from "../loginThrottle";
import { listSecurityEvents, recordSecurityEvent } from "../securityEvents";
import { sessionClient, type SessionAccess } from "../sessionAccess";
import { setupStatusVisibleTo, type SetupTokenGate } from "../setupToken";
import { describeUserAgent, minimumPasswordLength, type AuthMe, type AuthSessionList, type SecurityEventPage } from "../../shared/auth";

const usernameSchema = z.string({ error: "Username is required" }).trim().min(1, "Username is required").max(100, "Username must be 100 characters or fewer");
const newPasswordSchema = z
  .string({ error: "Password is required" })
  .min(minimumPasswordLength, `Password must be at least ${minimumPasswordLength} characters`)
  .max(256, "Password must be 256 characters or fewer");

// Sign-in accepts any stored password length, so passwords set before the
// 12-character minimum keep working until they are changed.
const loginSchema = z.object({
  username: usernameSchema,
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(256, "Password must be 256 characters or fewer")
});

const setupSchema = z
  .object({
    setupToken: z.string({ error: "Setup token is required" }).trim().min(1, "Setup token is required").max(512, "Setup token is not valid"),
    username: usernameSchema,
    password: newPasswordSchema,
    confirmPassword: z.string({ error: "Confirm the password" }).max(256, "Confirm password must be 256 characters or fewer")
  })
  .refine((body) => body.password === body.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

const optionalPasswordSchema = z.preprocess((value) => (value === "" ? undefined : value), newPasswordSchema.optional());

const userSettingsSchema = z
  .object({
    username: usernameSchema,
    currentPassword: z.string().min(1, "Current password is required").max(256, "Current password must be 256 characters or fewer"),
    newPassword: optionalPasswordSchema,
    confirmNewPassword: z.preprocess((value) => (value === "" ? undefined : value), z.string().max(256, "Confirm password must be 256 characters or fewer").optional())
  })
  .refine((body) => !body.newPassword || body.newPassword === body.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"]
  });

const sessionIdSchema = z.object({ id: z.coerce.number().int().positive() });
const securityEventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional()
});

const loginFailed = "Invalid username or password";

export interface AuthRouteOptions {
  sessions: SessionAccess;
  setupTokens: SetupTokenGate;
  throttle: LoginThrottle;
  /** Caps concurrent password checks, see {@link ConcurrencyGate}. */
  verificationGate: ConcurrencyGate;
  securityEventRetentionDays: number;
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, options: AuthRouteOptions): void {
  const { sessions, setupTokens, throttle, verificationGate } = options;

  const signInLocked = (reply: FastifyReply, retryAfterMs: number): SignInLockedError => {
    const locked = new SignInLockedError(retryAfterMs);
    reply.header("Retry-After", String(locked.retryAfterSeconds));
    return locked;
  };

  const signInBusy = (reply: FastifyReply): AppError => {
    reply.header("Retry-After", "1");
    return new AppError("The server is busy checking other sign-ins. Try again in a moment.", 429, { code: "sign_in_busy" });
  };

  const adoptSession = (request: FastifyRequest, reply: FastifyReply, started: { token: string; session: ActiveSession }): ActiveSession => {
    sessions.issue(reply, started.token, started.session.expiresAt);
    request.adminSession = started.session;
    return started.session;
  };

  const startSession = async (request: FastifyRequest, reply: FastifyReply, userId: number): Promise<ActiveSession> =>
    adoptSession(request, reply, await createSession(db, userId, sessions.policy, sessionClient(request)));

  const requireSession = (request: FastifyRequest): ActiveSession => {
    // The request guard has already resolved the session for admin routes.
    if (!request.adminSession) throw new AppError("Authentication required", 401);
    return request.adminSession;
  };

  app.get("/api/auth/me", async (request, reply): Promise<AuthMe> => {
    const session = await sessions.resolve(request, reply);
    if (session) {
      return { authenticated: true, user: { id: session.userId, username: session.username, role: session.role, mustChangePassword: session.mustChangePassword }, setupRequired: false };
    }
    let setupRequired = false;
    if (setupStatusVisibleTo(request) && !(await hasOwner(db))) {
      setupTokens.prepare();
      setupRequired = true;
    }
    return { authenticated: false, user: null, setupRequired };
  });

  app.post("/api/auth/setup", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const body = setupSchema.parse(request.body);
    if (!(await hasOwner(db))) setupTokens.prepare();
    if (!setupTokens.verify(body.setupToken)) {
      await recordSecurityEvent(db, { event: "setup_rejected", request, username: body.username, details: { reason: "token" } });
      throw new SetupUnavailableError();
    }
    const user = await createOwner(db, body.username, body.password);
    if (!user) {
      await recordSecurityEvent(db, { event: "setup_rejected", request, username: body.username, details: { reason: "completed" } });
      throw new SetupUnavailableError();
    }
    setupTokens.complete();
    request.log.info("Initial setup completed; the setup token is no longer valid.");
    await markOnboardingAccountCreated(db);
    const session = await startSession(request, reply, user.id);
    await recordSecurityEvent(db, { event: "setup_completed", request, userId: user.id, username: user.username, sessionId: session.id });
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    // Checked first, so a locked client never takes a password check slot.
    const blocked = throttle.check(body.username, request.ip);
    if (!blocked.allowed) throw signInLocked(reply, blocked.retryAfterMs);
    const release = verificationGate.tryAcquire();
    if (!release) throw signInBusy(reply);
    let succeeded: { result: NonNullable<Awaited<ReturnType<typeof authenticate>>>; started: NonNullable<Awaited<ReturnType<typeof createSessionForSignIn>>> };
    try {
      // Counted as a failure before the password is checked, and refunded on success,
      // so parallel attempts cannot all slip past the check.
      const reserved = throttle.reserve(body.username, request.ip);
      if (!reserved.allowed) throw signInLocked(reply, reserved.retryAfterMs);
      let result: Awaited<ReturnType<typeof authenticate>>;
      let started: Awaited<ReturnType<typeof createSessionForSignIn>> | null;
      try {
        result = await authenticate(db, body.username, body.password);
        started = result ? await createSessionForSignIn(db, result.user, sessions.policy, sessionClient(request)) : null;
      } catch (error) {
        throttle.cancelled(reserved.reservation);
        throw error;
      }
      if (!result || !started) {
        const failure = throttle.failed(reserved.reservation);
        await recordSecurityEvent(db, { event: "login_failed", request, username: body.username });
        if (failure.lockedNow) {
          await recordSecurityEvent(db, { event: "login_locked", request, username: body.username, details: { retryAfterSeconds: Math.ceil(failure.retryAfterMs / 1000) } });
        }
        return reply.code(401).send({ error: loginFailed });
      }
      throttle.succeeded(reserved.reservation);
      succeeded = { result, started };
    } finally {
      release();
    }
    const { result, started } = succeeded;
    const session = adoptSession(request, reply, started);
    await recordSecurityEvent(db, {
      event: "login_succeeded",
      request,
      userId: result.user.id,
      username: result.user.username,
      sessionId: session.id,
      details: result.rehashed ? { passwordRehashed: true } : {}
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await sessions.resolve(request, reply);
    if (session) {
      await deleteSession(db, session.tokenHash);
      await recordSecurityEvent(db, { event: "logout", request, userId: session.userId, username: session.username, sessionId: session.id });
    }
    sessions.clear(reply);
    return { ok: true };
  });

  app.put("/api/auth/user", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const session = requireSession(request);
    const body = userSettingsSchema.parse(request.body);
    const user = await first(db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, session.userId)).limit(1));
    if (!user) return reply.code(401).send({ error: "Authentication required" });

    const release = verificationGate.tryAcquire();
    if (!release) throw signInBusy(reply);
    let passwordMatches: boolean;
    try {
      passwordMatches = await passwordHashing.verify(body.currentPassword, user.passwordHash);
    } finally {
      release();
    }
    if (!passwordMatches) {
      await recordSecurityEvent(db, { event: "reauthentication_failed", request, userId: user.id, username: user.username, sessionId: session.id });
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    const username = body.username.trim();
    const conflictingUser = await findAdminByUsername(db, username);
    if (conflictingUser && conflictingUser.id !== user.id) {
      return reply.code(409).send({ error: "Username is already in use" });
    }

    if (user.mustChangePassword) {
      if (!body.newPassword) return reply.code(400).send({ error: "Choose a new password to replace your temporary one." });
      if (body.newPassword === body.currentPassword) return reply.code(400).send({ error: "Your new password must be different from your temporary one." });
    }

    const usernameChanged = username !== user.username;
    const values: { username: string; passwordHash?: string; mustChangePassword?: boolean } = { username };
    if (body.newPassword) {
      values.passwordHash = await passwordHashing.hash(body.newPassword);
      values.mustChangePassword = false;
    } else await rehashIfNeeded(db, user, body.currentPassword);
    // Held against the password just checked, so a reset by a manager cannot be undone by a change already in flight.
    const replaced = await db.transaction(async (transaction) => {
      const current = await first(transaction.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, user.id)).for("update").limit(1));
      if (!current || current.disabledAt || current.mustChangePassword !== user.mustChangePassword || (body.newPassword && current.passwordHash !== user.passwordHash)) return null;
      await transaction.update(schema.adminUsers).set(values).where(eq(schema.adminUsers.id, user.id));
      if (body.newPassword) {
        // A new password signs out every session, including other devices.
        const revoked = await revokeAllUserSessions(transaction, user.id);
        return { revoked, started: await insertSession(transaction, user.id, sessions.policy, sessionClient(request)) };
      }
      if (!usernameChanged) return { revoked: 0, started: null };
      // Rotate the current session after an account change.
      await deleteSession(transaction, session.tokenHash);
      return { revoked: 0, started: await insertSession(transaction, user.id, sessions.policy, sessionClient(request)) };
    });
    if (!replaced) return reply.code(409).send({ error: "This account changed while you were saving. Sign in and try again." });

    if (usernameChanged) {
      await recordSecurityEvent(db, { event: "username_changed", request, userId: user.id, username, sessionId: session.id, details: { previousUsername: user.username } });
    }
    if (replaced.started) {
      const replacement = adoptSession(request, reply, replaced.started);
      if (!body.newPassword) return { user: { id: user.id, username, role: session.role, mustChangePassword: user.mustChangePassword } };
      await recordSecurityEvent(db, { event: "password_changed", request, userId: user.id, username, sessionId: replacement.id, details: { sessionsSignedOut: Math.max(0, replaced.revoked - 1), ...(user.mustChangePassword ? { replacedTemporary: true } : {}) } });
    }

    return { user: { id: user.id, username, role: session.role, mustChangePassword: user.mustChangePassword && !body.newPassword } };
  });

  app.get("/api/auth/sessions", async (request): Promise<AuthSessionList> => {
    const session = requireSession(request);
    const rows = await listUserSessions(db, session.userId);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.tokenHash === session.tokenHash,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: sessionDeadline(row),
        ip: row.ip,
        device: describeUserAgent(row.userAgent)
      })),
      idleTimeoutHours: sessions.policy.idleTimeoutMs / 3_600_000,
      maxAgeDays: sessions.policy.maxAgeMs / 86_400_000
    };
  });

  app.delete("/api/auth/sessions/:id", async (request, reply) => {
    const session = requireSession(request);
    const { id } = sessionIdSchema.parse(request.params);
    const revokedTokenHash = await revokeUserSession(db, session.userId, id);
    if (!revokedTokenHash) return reply.code(404).send({ error: "Session not found" });
    const current = revokedTokenHash === session.tokenHash;
    if (current) sessions.clear(reply);
    await recordSecurityEvent(db, { event: "session_revoked", request, userId: session.userId, username: session.username, sessionId: session.id, details: { revokedSessionId: id, current } });
    return { ok: true, current };
  });

  app.post("/api/auth/sessions/revoke-others", async (request) => {
    const session = requireSession(request);
    const revoked = await revokeOtherUserSessions(db, session.userId, session.tokenHash);
    await recordSecurityEvent(db, { event: "sessions_revoked", request, userId: session.userId, username: session.username, sessionId: session.id, details: { count: revoked } });
    return { ok: true, revoked };
  });

  app.get("/api/auth/security-events", async (request): Promise<SecurityEventPage> => {
    const query = securityEventQuerySchema.parse(request.query);
    const page = await listSecurityEvents(db, { limit: query.limit, beforeId: query.before });
    return { ...page, retentionDays: options.securityEventRetentionDays };
  });
}
