import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db/database";
import { findActiveSession, hashToken, markSessionCookieReissued, touchSession, type ActiveSession, type SessionClient, type SessionPolicy } from "./auth";

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in admin session, set by the request guard or by `SessionAccess.resolve`. */
    adminSession: ActiveSession | null;
  }
}

export interface SessionCookieSettings {
  /** The cookie the session is issued under. */
  name: string;
  /** Older names still accepted once, then exchanged for `name`. */
  legacyNames: string[];
  secure: boolean;
}

/**
 * With Secure cookies, the session cookie takes the `__Host-` prefix, which
 * browsers accept only with Secure, `Path=/` and no Domain, so neither a
 * sibling subdomain nor a plain-HTTP response can plant or overwrite it.
 */
export function sessionCookieSettings(baseName: string, secure: boolean): SessionCookieSettings {
  const plainName = baseName.replace(/^__Host-/, "");
  return secure ? { name: `__Host-${plainName}`, legacyNames: [plainName], secure } : { name: plainName, legacyNames: [], secure };
}

/** Parallel requests from one page load may all carry the old cookie name; they share this window. */
export const legacyCookieGraceMs = 60_000;

export interface SessionAccess {
  readonly cookie: SessionCookieSettings;
  readonly policy: SessionPolicy;
  /** Finds the request's session, moving an old-name cookie to the current name. Cached per request. */
  resolve(request: FastifyRequest, reply: FastifyReply): Promise<ActiveSession | null>;
  issue(reply: FastifyReply, token: string, expiresAt: string): void;
  clear(reply: FastifyReply): void;
}

export function sessionClient(request: FastifyRequest): SessionClient {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip || null, userAgent: typeof userAgent === "string" ? userAgent : null };
}

export function createSessionAccess(db: Db, cookie: SessionCookieSettings, policy: SessionPolicy, clock: () => number = Date.now): SessionAccess {
  const resolved = new WeakMap<FastifyRequest, Promise<ActiveSession | null>>();
  const cookieOptions = { httpOnly: true, sameSite: "strict" as const, path: "/", secure: cookie.secure };

  const issue = (reply: FastifyReply, token: string, expiresAt: string) => {
    const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - clock()) / 1000));
    reply.setCookie(cookie.name, token, { ...cookieOptions, maxAge });
  };
  const clearLegacy = (reply: FastifyReply, name: string) => {
    reply.clearCookie(name, { httpOnly: true, sameSite: "strict", path: "/" });
  };
  const clear = (reply: FastifyReply) => {
    reply.clearCookie(cookie.name, cookieOptions);
    for (const name of cookie.legacyNames) clearLegacy(reply, name);
  };

  async function lookup(request: FastifyRequest, reply: FastifyReply): Promise<ActiveSession | null> {
    const now = clock();
    const current = request.cookies[cookie.name];
    const legacy = cookie.legacyNames.map((name) => ({ name, token: request.cookies[name] })).filter((entry): entry is { name: string; token: string } => Boolean(entry.token));
    for (const entry of legacy) clearLegacy(reply, entry.name);

    if (current) {
      const session = await findActiveSession(db, hashToken(current), now);
      if (session) await touchSession(db, session, policy, sessionClient(request), now);
      return session;
    }

    // A cookie from before the rename is accepted once (with a short grace for
    // parallel requests) and reissued under the current name.
    for (const entry of legacy) {
      const session = await findActiveSession(db, hashToken(entry.token), now);
      if (!session) continue;
      if (session.cookieReissuedAt) {
        const reissuedAt = Date.parse(session.cookieReissuedAt);
        if (!Number.isFinite(reissuedAt) || now - reissuedAt > legacyCookieGraceMs) continue;
      } else {
        await markSessionCookieReissued(db, session, now);
      }
      await touchSession(db, session, policy, sessionClient(request), now);
      issue(reply, entry.token, session.expiresAt);
      return session;
    }
    return null;
  }

  return {
    cookie,
    policy,
    issue,
    clear,
    resolve(request, reply) {
      let pending = resolved.get(request);
      if (!pending) {
        pending = lookup(request, reply).then((session) => {
          request.adminSession = session;
          return session;
        });
        resolved.set(request, pending);
      }
      return pending;
    }
  };
}
