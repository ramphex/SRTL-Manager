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
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    const method = request.method();
    let response: unknown = [];
    let status = 200;
    if (url.pathname.startsWith("/api/media-servers")) calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test" } };
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
      const input = body as { kind: "plex" | "jellyfin"; name: string; url: string; token?: string };
      list.servers = [...list.servers, { id: "jf2", kind: input.kind, name: input.name, url: input.url, hasToken: Boolean(input.token), prefixMappings: [], machineIdentifier: null, accountName: null, version: null, lastCheckedAt: null, lastError: null }];
      response = list;
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
  return { list, calls };
}

async function openMediaServers(page: Page) {
  await page.goto(`${baseUrl}/settings/media-servers`);
  await expect(page.getByRole("heading", { name: "Settings > Media servers" })).toBeVisible();
}

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
  await page.getByRole("button", { name: "Add Jellyfin server" }).click();
  const form = page.getByRole("form", { name: "Add Jellyfin server" });
  await form.getByLabel("Name", { exact: true }).fill("Basement");
  await form.getByLabel("Server URL").fill("http://basement:8096");
  await form.getByLabel("API key", { exact: true }).fill("new-api-key");
  await form.getByRole("button", { name: "Add server" }).click();
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
