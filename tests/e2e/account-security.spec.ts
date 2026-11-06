import { expect, test, type Page } from "@playwright/test";
import type { AuthMe, AuthSessionList, SecurityEventPage } from "../../src/shared/auth";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

async function signedOut(page: Page, me: AuthMe, onSetup: (body: unknown) => { status: number; body: unknown }) {
  const calls: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ status: 200, json: me });
    } else if (url.pathname === "/api/auth/setup" && request.method() === "POST") {
      const body = request.postDataJSON() as unknown;
      calls.push(body);
      const response = onSetup(body);
      await route.fulfill({ status: response.status, json: response.body });
    } else {
      await route.fulfill({ status: 401, json: { error: "Authentication required" } });
    }
  });
  return calls;
}

test("first-run setup asks for the setup token and explains where to find it", async ({ page }) => {
  const calls = await signedOut(page, { authenticated: false, setupRequired: true, user: null }, (body) =>
    (body as { setupToken?: string }).setupToken === "example-setup-token-0123456789"
      ? { status: 200, body: { ok: true } }
      : { status: 403, body: { error: "Setup is not available. Check the setup token in the server log." } }
  );
  await page.goto(baseUrl!);
  await expect(page.locator(".auth-header .brand h1")).toHaveText("Initial setup");
  await expect(page.locator(".auth-help")).toContainText("docker compose logs api");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Back to sign in" })).toHaveCount(0);

  await page.getByLabel("Username", { exact: true }).fill("alex_03");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Confirm password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.locator(".auth-form .error")).toHaveText("Enter the setup token from the server log.");
  expect(calls).toHaveLength(0);

  await page.getByLabel("Setup token").fill("wrong-token-000000000000000");
  await page.getByLabel("Password", { exact: true }).fill("too-short");
  await page.getByLabel("Confirm password").fill("too-short");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.locator(".auth-form .error")).toHaveText("Password must be at least 12 characters.");

  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Confirm password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.locator(".auth-form .error")).toHaveText("Setup is not available. Check the setup token in the server log.");

  await page.getByLabel("Setup token").fill(" example-setup-token-0123456789 ");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1]).toEqual({ setupToken: "example-setup-token-0123456789", username: "alex_03", password: "correct-horse-battery", confirmPassword: "correct-horse-battery" });
});

async function expectNoSetupOnSignIn(page: Page) {
  await expect(page.locator(".auth-header .brand h1")).toHaveText("Sign in");
  await expect(page.getByText(/set ?up/i)).toHaveCount(0);
}

test("sign-in has no setup link, and the setup address opens the form", async ({ page }) => {
  await signedOut(page, { authenticated: false, setupRequired: false, user: null }, () => ({ status: 403, body: { error: "Setup is not available. Check the setup token in the server log." } }));
  await page.goto(baseUrl!);
  await expectNoSetupOnSignIn(page);

  await page.goto(`${baseUrl}/setup`);
  await expect(page.locator(".auth-header .brand h1")).toHaveText("Initial setup");
  await expect(page.getByLabel("Setup token")).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expectNoSetupOnSignIn(page);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a server that is already set up shows no setup link and refuses setup at its setup address", async ({ page }) => {
  test.skip(!process.env.SRTL_E2E_SESSION_TOKEN, "Needs a real server that is already set up.");
  await page.goto(baseUrl!);
  await expectNoSetupOnSignIn(page);

  await page.goto(`${baseUrl}/setup`);
  await expect(page.locator(".auth-header .brand h1")).toHaveText("Initial setup");
  await page.getByLabel("Setup token").fill("example-setup-token-0123456789");
  await page.getByLabel("Username", { exact: true }).fill("alex_03");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Confirm password").fill("correct-horse-battery");
  const refused = page.waitForResponse("**/api/auth/setup");
  await page.getByRole("button", { name: "Create admin" }).click();
  const response = await refused;
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ code: "setup_unavailable" });
  await expect(page.locator(".auth-form .error")).toHaveText("Setup is not available. Check the setup token in the server log.");
});

test("finishing setup at the setup address leaves it", async ({ page }) => {
  await signedOut(page, { authenticated: false, setupRequired: false, user: null }, () => ({ status: 403, body: { error: "Setup is not available." } }));
  await page.goto(`${baseUrl}/setup`);
  await page.getByLabel("Setup token").fill("example-setup-token-0123456789");
  await page.getByLabel("Username", { exact: true }).fill("alex_03");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Confirm password").fill("correct-horse-battery");
  // From here on the server answers as if the admin now exists and this browser is signed in.
  await signedIn(page);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect(page.getByLabel("Setup token")).toHaveCount(0);
});

test("a signed-in browser never sees the setup form", async ({ page }) => {
  await signedIn(page);
  await page.goto(`${baseUrl}/setup`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect(page.getByLabel("Setup token")).toHaveCount(0);
});

function sessionList(): AuthSessionList {
  return {
    idleTimeoutHours: 12,
    maxAgeDays: 14,
    sessions: [
      { id: 11, current: true, createdAt: "2026-11-02T08:00:00.000Z", lastSeenAt: "2026-11-02T09:30:00.000Z", expiresAt: "2026-11-02T21:30:00.000Z", ip: "192.168.1.20", device: "Firefox on macOS" },
      { id: 12, current: false, createdAt: "2026-11-01T18:00:00.000Z", lastSeenAt: "2026-11-01T22:00:00.000Z", expiresAt: "2026-11-02T10:00:00.000Z", ip: "203.0.113.25", device: "Safari on iOS" },
      { id: 13, current: false, createdAt: "2026-10-30T07:00:00.000Z", lastSeenAt: "2026-10-31T07:00:00.000Z", expiresAt: "2026-10-31T19:00:00.000Z", ip: "192.168.1.30", device: "Chrome on Windows" }
    ]
  };
}

function eventPage(): SecurityEventPage {
  return {
    retentionDays: 90,
    hasMore: false,
    events: [
      { id: 5, createdAt: "2026-11-02T09:00:00.000Z", event: "login_succeeded", username: "alex_03", ip: "192.168.1.20", device: "Firefox on macOS", details: { passwordRehashed: true } },
      { id: 4, createdAt: "2026-11-02T08:58:00.000Z", event: "login_locked", username: "alex_03", ip: "203.0.113.40", device: null, details: { retryAfterSeconds: 30 } },
      { id: 3, createdAt: "2026-11-02T08:57:00.000Z", event: "login_failed", username: "alex_03", ip: "203.0.113.40", device: "curl", details: {} },
      { id: 2, createdAt: "2026-11-01T18:00:00.000Z", event: "setup_completed", username: "alex_03", ip: "192.168.1.20", device: "Firefox on macOS", details: {} }
    ]
  };
}

async function signedIn(page: Page) {
  const list = sessionList();
  const calls: Array<{ method: string; path: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    let body: unknown = [];
    if (url.pathname.startsWith("/api/auth/sessions") || url.pathname === "/api/auth/security-events") calls.push({ method, path: url.pathname });
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "alex_03", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.3", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.3", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/auth/sessions" && method === "GET") body = list;
    else if (url.pathname === "/api/auth/sessions/revoke-others" && method === "POST") {
      const revoked = list.sessions.filter((session) => !session.current).length;
      list.sessions = list.sessions.filter((session) => session.current);
      body = { ok: true, revoked };
    } else if (/^\/api\/auth\/sessions\/\d+$/.test(url.pathname) && method === "DELETE") {
      const id = Number(url.pathname.split("/").pop());
      list.sessions = list.sessions.filter((session) => session.id !== id);
      body = { ok: true, current: false };
    } else if (url.pathname === "/api/auth/security-events") body = eventPage();
    await route.fulfill({ status: 200, json: body });
  });
  return calls;
}

test("user settings list signed-in sessions and sign them out", async ({ page }) => {
  const calls = await signedIn(page);
  await page.goto(`${baseUrl}/settings/user`);
  await expect(page.getByRole("heading", { name: "Settings > User settings" })).toBeVisible();

  const sessions = page.getByRole("region", { name: "Signed-in sessions" });
  await expect(sessions.getByRole("row")).toHaveCount(4);
  await expect(sessions).toContainText("Firefox on macOS");
  await expect(sessions).toContainText("This browser");
  await expect(sessions).toContainText("203.0.113.25");
  await expect(page.getByText("A session ends after 12 hours without activity and 14 days after sign-in.")).toBeVisible();

  await page.getByRole("button", { name: "Sign out Safari on iOS at 203.0.113.25" }).click();
  await expect(page.getByText("Session signed out.")).toBeVisible();
  await expect(sessions.getByRole("row")).toHaveCount(3);
  expect(calls).toContainEqual({ method: "DELETE", path: "/api/auth/sessions/12" });

  await page.getByRole("button", { name: "Sign out all other sessions" }).click();
  await expect(page.getByText("Signed out 1 other session.")).toBeVisible();
  await expect(sessions.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Sign out all other sessions" })).toBeDisabled();
  expect(calls).toContainEqual({ method: "POST", path: "/api/auth/sessions/revoke-others" });
});

test("user settings show a read-only security activity log", async ({ page }) => {
  await signedIn(page);
  await page.goto(`${baseUrl}/settings/user`);
  const activity = page.getByRole("region", { name: "Security activity" });
  await expect(activity.getByRole("row")).toHaveCount(5);
  await expect(activity).toContainText("Signed in");
  await expect(activity).toContainText("Password hash upgraded");
  await expect(activity).toContainText("Sign-in temporarily locked");
  await expect(activity).toContainText("Locked for 30 seconds");
  await expect(activity).toContainText("Initial setup completed");
  await expect(page.getByText("Entries are kept for 90 days.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load older activity" })).toHaveCount(0);
  await expect(activity.getByRole("button")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
