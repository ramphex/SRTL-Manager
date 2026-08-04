import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { createAdmin, findAdminByUsername, getSessionUser, hashPassword, hasAdmin, login, logout, verifyPassword } from "../auth";
import { first, type Db } from "../db/database";
import * as schema from "../db/schema";
import { markOnboardingAccountCreated } from "../lib/onboarding";

const credentialsSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(100, "Username must be 100 characters or fewer").default("admin"),
  password: z.string().min(8, "Password must be at least 8 characters").max(256, "Password must be 256 characters or fewer")
});

const setupSchema = credentialsSchema
  .extend({
    confirmPassword: z.string().min(8, "Confirm password must be at least 8 characters").max(256, "Confirm password must be 256 characters or fewer")
  })
  .refine((body) => body.password === body.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"]
  });

const optionalPasswordSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(8, "Password must be at least 8 characters").max(256, "Password must be 256 characters or fewer").optional()
);

const userSettingsSchema = z
  .object({
    username: z.string().trim().min(1, "Username is required").max(100, "Username must be 100 characters or fewer"),
    currentPassword: z.string().min(1, "Current password is required").max(256, "Current password must be 256 characters or fewer"),
    newPassword: optionalPasswordSchema,
    confirmNewPassword: z.preprocess((value) => (value === "" ? undefined : value), z.string().max(256, "Confirm password must be 256 characters or fewer").optional())
  })
  .refine((body) => !body.newPassword || body.newPassword === body.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"]
  });

interface AuthRouteOptions {
  cookieName: string;
  cookieSecure: boolean;
}

function setSessionCookie(reply: FastifyReply, options: AuthRouteOptions, token: string): void {
  reply.setCookie(options.cookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: options.cookieSecure,
    maxAge: 60 * 60 * 24 * 14
  });
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, options: AuthRouteOptions): void {
  const { cookieName } = options;
  app.get("/api/auth/me", async (request) => {
    const user = await getSessionUser(db, request.cookies[cookieName]);
    return { authenticated: Boolean(user), user, setupRequired: !(await hasAdmin(db)) };
  });

  app.post("/api/auth/setup", { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } }, async (request, reply) => {
    if (await hasAdmin(db)) return reply.code(409).send({ error: "Setup has already been completed" });
    const body = setupSchema.parse(request.body);
    const created = await createAdmin(db, body.username, body.password);
    if (!created) return reply.code(409).send({ error: "Setup has already been completed" });
    await markOnboardingAccountCreated(db);
    const token = await login(db, body.username, body.password);
    if (!token) return reply.code(500).send({ error: "Admin was created but automatic login failed" });
    setSessionCookie(reply, options, token);
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = credentialsSchema.parse(request.body);
    const token = await login(db, body.username, body.password);
    if (!token) return reply.code(401).send({ error: "Invalid username or password" });
    setSessionCookie(reply, options, token);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await logout(db, request.cookies[cookieName]);
    reply.clearCookie(cookieName, { path: "/", sameSite: "strict", secure: options.cookieSecure });
    return { ok: true };
  });

  app.put("/api/auth/user", async (request, reply) => {
    const sessionUser = await getSessionUser(db, request.cookies[cookieName]);
    if (!sessionUser) return reply.code(401).send({ error: "Authentication required" });

    const body = userSettingsSchema.parse(request.body);
    const user = await first(db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, sessionUser.id)).limit(1));
    if (!user) return reply.code(401).send({ error: "Authentication required" });

    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: "Current password is incorrect" });
    }

    const username = body.username.trim();
    const conflictingUser = await findAdminByUsername(db, username);
    if (conflictingUser && conflictingUser.id !== user.id) {
      return reply.code(409).send({ error: "Username is already in use" });
    }

    const values: { username: string; passwordHash?: string } = { username };
    if (body.newPassword) values.passwordHash = await hashPassword(body.newPassword);
    await db.update(schema.adminUsers).set(values).where(eq(schema.adminUsers.id, user.id));

    if (body.newPassword) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      const token = await login(db, username, body.newPassword);
      if (!token) return reply.code(500).send({ error: "Password changed but the replacement session could not be created" });
      setSessionCookie(reply, options, token);
    }

    return { user: { id: user.id, username } };
  });
}
