import { expect, test, type Page } from "@playwright/test";
import type { MediaServer, MediaServerList } from "../../src/shared/mediaServers";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function servers(): MediaServer[] {
  return [
    { id: "plex1", kind: "plex", name: "Home Plex", url: "http://plex:32400", hasToken: true, prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/plex" }], machineIdentifier: "m1", accountName: "alex_03", version: "1.43.0", lastCheckedAt: "2026-11-01T11:00:00.000Z", lastError: null },
    { id: "jf1", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", hasToken: true, prefixMappings: [], machineIdentifier: null, accountName: null, version: null, lastCheckedAt: null, lastError: null }
  ];
}

async function fixture(page: Page) {
  const list: MediaServerList = { servers: servers(), limit: 10 };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let pinChecks = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    const method = request.method();
    let response: unknown = [];
    let status = 200;
    if (url.pathname.startsWith("/api/media-servers")) calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") response = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") response = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") response = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") response = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") response = { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.3", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      response = { currentVersion: "0.1.4-beta.3", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/media-servers" && method === "GET") response = list;
    else if (url.pathname === "/api/media-servers" && method === "POST") {
      const input = body as { kind: MediaServer["kind"]; name: string; url: string; token?: string };
      list.servers = [...list.servers, { id: "jf2", kind: input.kind, name: input.name, url: input.url, hasToken: Boolean(input.token), prefixMappings: [], machineIdentifier: null, accountName: null, version: null, lastCheckedAt: null, lastError: null }];
      response = list;
    } else if (url.pathname === "/api/media-servers/jf2/plex-pin" && method === "POST") {
      response = { pinId: 77, code: "WXYZ", authUrl: "about:blank#plex-sign-in", expiresAt: "2026-11-02T10:00:00.000Z" };
    } else if (url.pathname === "/api/media-servers/jf2/plex-pin/77" && method === "POST") {
      pinChecks += 1;
      // The sign-in completes on the second check; any later check would be a late poll.
      if (pinChecks >= 2) {
        list.servers = list.servers.map((server) => server.id === "jf2" ? { ...server, hasToken: true, accountName: "alex_03", version: "1.43.0", lastCheckedAt: "2026-11-02T09:00:00.000Z" } : server);
        response = { status: "authorized", servers: list };
      } else response = { status: "waiting" };
    } else if (url.pathname === "/api/media-servers/jf1/test") {
      list.servers = list.servers.map((server) => server.id === "jf1" ? { ...server, version: "10.10.0", lastCheckedAt: "2026-11-02T09:00:00.000Z" } : server);
      response = list;
    } else if (url.pathname === "/api/media-servers/jf1" && method === "PUT") {
      const input = body as { name: string; url: string };
      list.servers = list.servers.map((server) => server.id === "jf1" ? { ...server, name: input.name, url: input.url } : server);
      response = list;
    } else if (url.pathname === "/api/media-servers/jf1" && method === "DELETE") {
      status = 409;
      response = { error: "Jellyfin is used by 1 watch sync pair: alex_03 ↔ Alex. Remove that pair in Settings > Integrations > Watch sync first." };
    }
    await route.fulfill({ status, json: response });
  });
  return { list, calls, pinChecks: () => pinChecks };
}

async function openMediaServers(page: Page) {
  await page.goto(`${baseUrl}/settings/media-servers`);
  await expect(page.getByRole("heading", { name: "Settings > Media servers" })).toBeVisible();
}

async function addServer(page: Page, kind: "Plex" | "Jellyfin" | "Dupelix") {
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByRole("menu", { name: "Server type" }).getByRole("menuitem", { name: kind, exact: true }).click();
}

test("one Add server button opens a menu of server types that works from the keyboard and fits a phone", async ({ page }) => {
  await fixture(page);
  await openMediaServers(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const trigger = page.getByRole("button", { name: "Add server", exact: true });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: /^Add (Plex|Jellyfin|Dupelix) server$/ })).toHaveCount(0);
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Server type" });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Plex", "Jellyfin", "Dupelix"]);
  await expect(menu.getByRole("menuitem", { name: "Plex" })).toBeFocused();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Jellyfin" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByText("Add each server once here").click();
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Dupelix" })).toBeFocused();
  await page.keyboard.press("Enter");
  const form = page.getByRole("form", { name: "Add Dupelix server" });
  await expect(form.getByLabel("Name", { exact: true })).toBeFocused();
  await expect(trigger).toBeDisabled();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeEnabled();
});

test("lists servers with type, URL, status, and version, and tests a connection", async ({ page }) => {
  const { calls } = await fixture(page);
  await openMediaServers(page);
  const plex = page.getByRole("region", { name: "Plex server Home Plex" });
  await expect(plex).toContainText("http://plex:32400");
  await expect(plex).toContainText("Plex 1.43.0");
  await expect(plex).toContainText("Connected");
  await expect(plex).toContainText("alex_03");
  await expect(plex.getByRole("button", { name: "Sign in with Plex again" })).toBeVisible();
  const jellyfin = page.getByRole("region", { name: "Jellyfin server Jellyfin" });
  await expect(jellyfin).toContainText("Not checked");
  await expect(jellyfin.getByRole("button", { name: /Sign in with Plex/ })).toHaveCount(0);
  await jellyfin.getByRole("button", { name: "Test connection" }).click();
  await expect(jellyfin).toContainText("Connected to Jellyfin 10.10.0.");
  expect(calls.some((call) => call.method === "POST" && call.path === "/api/media-servers/jf1/test")).toBe(true);
});

test("adds and edits a server without ever showing the saved key", async ({ page }) => {
  const { calls } = await fixture(page);
  await openMediaServers(page);
  await addServer(page, "Jellyfin");
  const form = page.getByRole("form", { name: "Add Jellyfin server" });
  await form.getByLabel("Name", { exact: true }).fill("Basement");
  await form.getByLabel("Server URL").fill("http://basement:8096");
  await form.getByLabel("API key", { exact: true }).fill("new-api-key");
  await form.getByRole("button", { name: "Add Jellyfin server" }).click();
  await expect(page.getByRole("region", { name: "Jellyfin server Basement" })).toBeVisible();
  expect(calls.find((call) => call.method === "POST" && call.path === "/api/media-servers")?.body).toMatchObject({ kind: "jellyfin", name: "Basement", url: "http://basement:8096", token: "new-api-key" });

  const jellyfin = page.getByRole("region", { name: "Jellyfin server Jellyfin" });
  await jellyfin.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: "Edit Jellyfin" });
  await expect(edit.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(edit.getByLabel("API key", { exact: true })).toHaveAttribute("placeholder", "Saved. Leave empty to keep it.");
  await edit.getByLabel("Name", { exact: true }).fill("Living room");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "Jellyfin server Living room" })).toBeVisible();
  expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ name: "Living room", url: "http://jellyfin:8096", token: "", prefixMappings: [] });
});

test("adds a Plex server by signing in with Plex, with pasting a token as the secondary option", async ({ page }) => {
  const { calls, pinChecks } = await fixture(page);
  await openMediaServers(page);
  await addServer(page, "Plex");
  const form = page.getByRole("form", { name: "Add Plex server" });
  await expect(form).toContainText("Sign in with Plex to connect automatically. SRTL gets the token from plex.tv for you.");
  await expect(form.getByLabel("Plex token")).toBeHidden();
  await form.getByText("Or enter a token manually").click();
  await expect(form.getByLabel("Plex token")).toBeVisible();
  await expect(form).toContainText("Never use the PlexOnlineToken");
  await form.getByLabel("Name", { exact: true }).fill("Basement Plex");
  await form.getByLabel("Server URL").fill("http://basement:32400");
  const popup = page.waitForEvent("popup");
  await form.getByRole("button", { name: "Add and sign in with Plex" }).click();
  await popup;
  const card = page.getByRole("region", { name: "Plex server Basement Plex" });
  await expect(card).toContainText("Signed in with Plex.", { timeout: 15_000 });
  await expect(card).toContainText("alex_03");
  await page.waitForTimeout(4000);
  expect(pinChecks()).toBe(2);
  await expect(card.locator(".error")).toHaveCount(0);
  expect(calls.find((call) => call.method === "POST" && call.path === "/api/media-servers")?.body).toMatchObject({ kind: "plex", name: "Basement Plex", token: "" });
  await expect(card.getByRole("button", { name: "Sign in with Plex again" })).toBeVisible();
});

test("adds a Dupelix server with an API key, naming the scopes it needs", async ({ page }) => {
  const { calls } = await fixture(page);
  await openMediaServers(page);
  await addServer(page, "Dupelix");
  const form = page.getByRole("form", { name: "Add Dupelix server" });
  await expect(form).toContainText("activity.read");
  await expect(form).toContainText("library.read");
  await expect(form.getByText("Or enter a token manually")).toHaveCount(0);
  await form.getByLabel("Name", { exact: true }).fill("Dupelix");
  await form.getByLabel("Server URL").fill("https://dupelix.example.com");
  await form.getByLabel("API key", { exact: true }).fill("msk_examplekeyexamplekey");
  await form.getByRole("button", { name: "Add Dupelix server" }).click();
  const card = page.getByRole("region", { name: "Dupelix server Dupelix" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Not checked");
  await expect(card.getByRole("button", { name: /Sign in with Plex/ })).toHaveCount(0);
  expect(calls.find((call) => call.method === "POST" && call.path === "/api/media-servers")?.body).toMatchObject({ kind: "dupelix", name: "Dupelix", url: "https://dupelix.example.com", token: "msk_examplekeyexamplekey" });
});

test("explains which watch sync pairs block removing a server", async ({ page }) => {
  await fixture(page);
  await openMediaServers(page);
  const jellyfin = page.getByRole("region", { name: "Jellyfin server Jellyfin" });
  await jellyfin.getByRole("button", { name: "Remove Jellyfin" }).click();
  await jellyfin.getByRole("group", { name: "Confirm removing Jellyfin" }).getByRole("button", { name: "Remove" }).click();
  await expect(jellyfin.getByRole("alert")).toContainText("used by 1 watch sync pair: alex_03 ↔ Alex");
  await expect(jellyfin).toBeVisible();
});

test("fits a phone screen without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  // Phones show the page title in the app bar instead of the page heading.
  await page.goto(`${baseUrl}/settings/media-servers`);
  await expect(page.getByRole("region", { name: "Plex server Home Plex" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
