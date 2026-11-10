import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";

let root: string;
let ctx: AppContext;
let database: TestDatabaseHandle;
let cookie: string;

const releases = (version: string) => new Response(JSON.stringify([{ tag_name: `v${version}`, html_url: "https://example.com/release", body: "Notes", prerelease: false, draft: false }]), { status: 200 });
const version = (refresh: boolean, headers: Record<string, string> = { cookie }, remoteAddress = "192.0.2.10") =>
  ctx.app.inject({ method: "GET", url: `/api/system/version${refresh ? "?refresh=true" : ""}`, headers, remoteAddress });

describe("version check", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-version-test-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    ctx = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    ctx.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(ctx.database.db);
    const setup = await ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(ctx), username: "alex_03", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await ctx.app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("joins a forced refresh to a check that is already running", async () => {
    let answer: (response: Response) => void = () => undefined;
    const githubFetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", githubFetch);

    const pending = [version(true), version(true), version(false)];
    await vi.waitFor(() => expect(githubFetch).toHaveBeenCalled());
    answer(releases("9.0.0"));
    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(responses.map((response) => response.json().stable.latestVersion)).toEqual(["9.0.0", "9.0.0", "9.0.0"]);
    expect(githubFetch).toHaveBeenCalledTimes(1);

    // Once that check is done, a refresh starts a new one.
    githubFetch.mockResolvedValueOnce(releases("9.0.1"));
    expect((await version(true)).json().stable.latestVersion).toBe("9.0.1");
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("limits forced refreshes per account, whatever the address, but never the cached result", async () => {
    const githubFetch = vi.fn().mockImplementation(async () => releases("9.0.0"));
    vi.stubGlobal("fetch", githubFetch);

    for (let attempt = 0; attempt < 10; attempt += 1) expect((await version(true)).statusCode).toBe(200);
    const limited = await version(true);
    expect(limited.statusCode).toBe(429);
    expect(githubFetch).toHaveBeenCalledTimes(10);

    // The same account signed in from another address shares the limit.
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.20", payload: { username: "alex_03", password: "fixture-password-123" } });
    expect(login.statusCode).toBe(200);
    const otherSession = { cookie: String(login.headers["set-cookie"]) };
    expect((await version(true, otherSession, "192.0.2.20")).statusCode).toBe(429);

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const cached = await version(false);
      expect(cached.statusCode).toBe(200);
      expect(cached.json().stable.latestVersion).toBe("9.0.0");
    }
    expect((await version(false, otherSession, "192.0.2.20")).statusCode).toBe(200);
    expect(githubFetch).toHaveBeenCalledTimes(10);
  });
});
