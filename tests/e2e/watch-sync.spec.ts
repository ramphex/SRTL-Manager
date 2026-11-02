import { expect, test, type Page } from "@playwright/test";
import type { MediaServer, MediaServerList } from "../../src/shared/mediaServers";
import type { RadarrOverview } from "../../src/shared/radarr";
import type { WatchSyncPair, WatchSyncState } from "../../src/shared/watchSync";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function pair(overrides: Partial<WatchSyncPair> = {}): WatchSyncPair {
  return {
    id: 1, plexServerId: "plex1", plexUserId: "100", plexUserName: "alex_03", jellyfinServerId: "jf1", jellyfinUserId: "u1", jellyfinUserName: "Alex",
    enabled: true, paused: false, direction: "both", syncWatched: null, syncPosition: null, approvedAt: null,
    preview: {
      generatedAt: "2026-11-01T12:00:00.000Z", jobId: 9,
      counts: { plex_to_jellyfin: { watched: 12, unwatched: 0, position: 2 }, jellyfin_to_plex: { watched: 3, unwatched: 0, position: 1 } },
      samples: [{ direction: "plex_to_jellyfin", action: "watched", title: "Alpha", linkPath: "/mnt/plex/movies/Alpha (2020)/Alpha.mkv", positionMs: null }],
      plexItems: 420, jellyfinItems: 418, matched: 400, skipped: 20
    },
    lastSyncAt: null, lastFullSyncAt: null, lastError: null, trackedItems: 0,
    ...overrides
  };
}

const servers: MediaServer[] = [
  { id: "plex1", kind: "plex", name: "Home Plex", url: "http://plex:32400", hasToken: true, prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/plex" }], machineIdentifier: "m1", accountName: "alex_03", version: "1.43.0", lastCheckedAt: "2026-11-01T11:00:00.000Z", lastError: null },
  { id: "jf1", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", hasToken: true, prefixMappings: [], machineIdentifier: null, accountName: null, version: "10.10.0", lastCheckedAt: null, lastError: "Jellyfin: Jellyfin returned HTTP 503." }
];

async function fixture(page: Page, options: { servers?: MediaServer[] } = {}) {
  const state: WatchSyncState = {
    settings: { revision: 3, paused: false, intervalMinutes: 5, reconcileIntervalDays: 7, syncWatched: true, syncPosition: true, lastReconcileAt: null },
    servers: options.servers ?? servers,
    users: [
      { serverId: "plex1", externalId: "100", name: "alex_03", username: "alex_03", kind: "owner", ready: true, note: null },
      { serverId: "plex1", externalId: "200", name: "Friend.Bob", username: "friendbob", kind: "friend", ready: true, note: null },
      { serverId: "plex1", externalId: "500", name: "NoShare", username: "noshare", kind: "friend", ready: false, note: "No server access token." },
      { serverId: "jf1", externalId: "u1", name: "Alex", username: null, kind: "user", ready: true, note: null },
      { serverId: "jf1", externalId: "u2", name: "friendbob", username: null, kind: "user", ready: true, note: null }
    ],
    pairs: options.servers?.length === 0 ? [] : [pair()],
    suggestions: [{ plexServerId: "plex1", plexUserId: "200", plexUserName: "Friend.Bob", jellyfinServerId: "jf1", jellyfinUserId: "u2", jellyfinUserName: "friendbob", match: "exact" }],
    activeJobs: [],
    indexedItems: { plex1: 400, jf1: 398 }
  };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    let response: unknown = [];
    if (url.pathname.startsWith("/api/settings/watch-sync")) calls.push({ method: request.method(), path: url.pathname, body });
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test" } };
    else if (url.pathname === "/api/system/path-migration") response = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") response = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") response = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") response = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") response = { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      response = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/settings/radarr") response = { instances: [], limit: 25 } satisfies RadarrOverview;
    else if (url.pathname === "/api/media-servers") response = { servers: state.servers, limit: 10 } satisfies MediaServerList;
    else if (url.pathname === "/api/settings/watch-sync") response = state;
    else if (url.pathname === "/api/settings/watch-sync/servers/plex1/discover") response = state;
    else if (url.pathname === "/api/settings/watch-sync/activity") response = { entries: [{ id: 1, pairId: 1, at: "2026-11-01T12:05:00.000Z", level: "info", direction: "plex_to_jellyfin", action: "watched", linkPath: "/mnt/plex/movies/Alpha (2020)/Alpha.mkv", message: "Marked \"Alpha\" watched on Jellyfin (from Plex).", jobId: null }] };
    else if (url.pathname === "/api/settings/watch-sync/pairs/1/approve") {
      state.pairs = [pair({ approvedAt: "2026-11-01T12:10:00.000Z" })];
      response = { jobId: 12 };
    } else if (url.pathname === "/api/settings/watch-sync/pairs" && request.method() === "POST") {
      state.pairs = [...state.pairs, pair({ id: 2, plexUserId: "200", plexUserName: "Friend.Bob", jellyfinUserId: "u2", jellyfinUserName: "friendbob", preview: null })];
      state.suggestions = [];
      response = state;
    } else if (url.pathname === "/api/settings/watch-sync/pairs/1" && request.method() === "PUT") {
      state.pairs = [pair({ ...state.pairs[0], ...(body as Partial<WatchSyncPair>) })];
      response = state;
    } else if (url.pathname === "/api/settings/watch-sync/pause") {
      state.settings = { ...state.settings, paused: (body as { paused: boolean }).paused };
      response = state;
    }
    await route.fulfill({ json: response });
  });
  return { state, calls };
}

async function openWatchSync(page: Page, heading = "Watch sync") {
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("tablist", { name: "Integrations" }).getByRole("tab", { name: "Watch sync" }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
}

function tab(page: Page, name: string) {
  return page.getByRole("tablist", { name: "Watch sync" }).getByRole("tab", { name });
}

test("lists each server's users and status, with the connection in Media servers", async ({ page }) => {
  const { calls } = await fixture(page);
  await openWatchSync(page);
  await expect(tab(page, "Users")).toHaveAttribute("aria-selected", "true");
  const plex = page.getByRole("region", { name: "Plex server Home Plex" });
  await expect(plex).toContainText("Plex account alex_03");
  await expect(plex).toContainText("400 SRTL items indexed");
  await expect(plex).toContainText("No server access token.");
  await expect(page.getByRole("region", { name: "Jellyfin server Jellyfin" })).toContainText("HTTP 503");
  // Server setup moved to Settings > Media servers; watch sync only discovers users.
  await expect(plex.getByRole("button", { name: /Sign in with Plex/ })).toHaveCount(0);
  await expect(plex.getByLabel("Server path prefix")).toHaveCount(0);
  await plex.getByRole("button", { name: "Discover users" }).click();
  await expect.poll(() => calls.some((call) => call.method === "POST" && call.path === "/api/settings/watch-sync/servers/plex1/discover")).toBe(true);
  await plex.getByRole("link", { name: "Edit Home Plex in Media servers" }).click();
  await expect(page).toHaveURL(/\/settings\/media-servers$/);
  await expect(page.getByRole("region", { name: "Plex server Home Plex" })).toContainText("Plex 1.43.0");
});

test("asks for a media server when none is connected", async ({ page }) => {
  await fixture(page, { servers: [] });
  await openWatchSync(page, "Watch sync needs a media server");
  await expect(page.getByText("Connect a Plex or Jellyfin server in Settings > Media servers.")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Watch sync" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open Media servers" }).click();
  await expect(page).toHaveURL(/\/settings\/media-servers$/);
  await expect(page.getByText("No media servers yet.")).toBeVisible();
});

test("shows the preview and starts syncing only after approval", async ({ page }) => {
  const { calls } = await fixture(page);
  await openWatchSync(page);
  await tab(page, "User pairs").click();
  const card = page.getByRole("article", { name: "alex_03 and Alex" });
  await expect(card).toContainText("Preview ready");
  const preview = card.getByRole("region", { name: "Preview" });
  await expect(preview).toContainText("Nothing has been written yet.");
  await expect(preview).toContainText("Plex → Jellyfin: 12 watched, 0 unwatched, 2 resume positions");
  await expect(preview).toContainText("Jellyfin → Plex: 3 watched");
  await card.getByRole("button", { name: "Approve and start syncing" }).click();
  await expect(card).toContainText("Queued job #12");
  expect(calls.some((call) => call.method === "POST" && call.path === "/api/settings/watch-sync/pairs/1/approve")).toBe(true);
  await card.getByLabel("Direction").selectOption("plex_to_jellyfin");
  await expect.poll(() => calls.find((call) => call.method === "PUT")?.body).toEqual({ direction: "plex_to_jellyfin" });
});

test("pairs a suggested user and pauses all syncing", async ({ page }) => {
  const { calls } = await fixture(page);
  await openWatchSync(page);
  await tab(page, "User pairs").click();
  await expect(page.getByText("Friend.Bob (Plex) ↔ friendbob (Jellyfin)")).toBeVisible();
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("article", { name: "Friend.Bob and friendbob" })).toContainText("Needs preview");
  expect(calls.find((call) => call.method === "POST" && call.path === "/api/settings/watch-sync/pairs")?.body).toMatchObject({ plexUserId: "200", jellyfinUserId: "u2", direction: "both" });
  await page.getByRole("button", { name: "Pause all" }).click();
  await expect(page.getByRole("button", { name: "Resume all" })).toBeVisible();
  await tab(page, "Activity").click();
  await expect(page.getByLabel("Watch sync activity")).toContainText("Marked \"Alpha\" watched on Jellyfin (from Plex).");
});

test("fits a phone screen without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  await openWatchSync(page);
  await tab(page, "User pairs").click();
  await expect(page.getByRole("article", { name: "alex_03 and Alex" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
