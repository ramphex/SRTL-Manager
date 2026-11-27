import { expect, test, type Page } from "@playwright/test";
import type { NowPlayingSnapshot, NowPlayingStream } from "../../src/shared/nowPlaying";

// Runs in WebKit as well as Chromium: Safari showed the Now Playing page flashing through the dashboard
// after moving between the two.
const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");
// The production build registers a service worker. Once it controls the page, WebKit sends API requests through it,
// where page.route no longer sees them, so the mocked API would give way to the real server.
test.use({ serviceWorkers: "block" });

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function stream(index: number): NowPlayingStream {
  return {
    id: `plex1:${index}`, serverId: "plex1", serverKind: "plex", serverName: "Home Plex", sessionKey: String(index), title: `Example Film ${index}`, mediaType: "movie",
    grandparentTitle: null, episodeLabel: null, year: 2021, posterUrl: `/api/now-playing/poster/${"p".repeat(31)}${index}`, user: { id: String(index), name: `viewer_${index}` },
    player: { name: "Living Room", device: "SHIELD", platform: "Android", product: "Plex for Android (TV)", version: "10.0" },
    state: "playing", positionMs: 600_000 + index * 60_000, durationMs: 7_200_000, bufferedMs: null, reportedAt: new Date().toISOString(),
    playMethod: "directPlay", videoDecision: "directPlay", audioDecision: "directPlay", subtitle: null,
    source: { container: "mkv", videoCodec: "h264", resolution: "1080p", width: 1920, height: 1080, dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 12000 },
    output: null, transcode: null, bandwidth: { kbps: 10_000, kind: "nominal" }, network: { location: "lan", ip: null, relayed: false, secure: true, geo: null },
    srtl: { status: "local", locationName: "Home NAS", policy: "location_1" }, stop: { available: true, reason: null }
  };
}

function snapshot(): NowPlayingSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    servers: [{ id: "plex1", name: "Home Plex", kind: "plex", status: "live", message: null, transport: "socket", plexPass: true, bandwidth: null, resources: null, lastUpdatedAt: new Date().toISOString() }],
    streams: Array.from({ length: 9 }, (_value, index) => stream(index + 1)),
    summary: { transcodeHardware: 0, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 9, paused: 0, totalKbps: 90_000, totalIsEstimate: false }
  };
}

/** Mocks the API. Every Now Playing stream after the first answers slowly, like a reconnect queued behind other requests. */
async function fixture(page: Page) {
  const streams = { opened: 0 };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let response: unknown = [];
    if (url.pathname === "/api/now-playing/events") {
      streams.opened += 1;
      if (streams.opened > 1) await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }, body: `retry: 600000\n\nevent: sessions\ndata: ${JSON.stringify(snapshot())}\n\n` }).catch(() => undefined);
      return;
    }
    if (url.pathname.startsWith("/api/now-playing/poster/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: pixel });
      return;
    }
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") response = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") response = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") response = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }] };
    else if (url.pathname === "/api/settings/user-preferences") response = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440, nowPlayingHiddenServers: [] };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.5", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      response = { currentVersion: "0.1.5", currentChannel: "stable", currentChannelLabel: "Stable", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/media-servers") {
      response = { servers: [{ id: "plex1", kind: "plex", name: "Home Plex", url: "http://media.example.com:32400", hasToken: true, prefixMappings: [], machineIdentifier: "m1", accountName: "owner", version: "1.43.0", lastCheckedAt: "2026-11-02T10:00:00.000Z", lastError: null }], limit: 10 };
    } else if (url.pathname === "/api/now-playing/settings") response = { geoLookup: true };
    else if (url.pathname === "/api/settings/sections") response = { sections: [], sectionTitles: {}, sectionTypes: {} };
    else if (url.pathname === "/api/settings/paths") response = { symlinkDir: "/mnt/links", localDir: "/mnt/local", remoteDir: "/mnt/remote" };
    else if (url.pathname === "/api/settings/scan") response = { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: [], localSections: [] };
    else if (url.pathname === "/api/settings/audit") response = { sections: [], targets: ["local"] };
    else if (url.pathname === "/api/inventory/scan-timestamps") response = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    await route.fulfill({ status: 200, json: response });
  });
  return streams;
}

test("Now Playing does not repaint every frame or blur what scrolls under its header", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/now-playing`);
  await expect(page.locator(".np-card")).toHaveCount(9);
  // Let the clock tick so every progress bar gets a new width.
  await page.waitForTimeout(1_500);
  const running = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").map((animation) => (animation as CSSTransition).transitionProperty ?? (animation as CSSAnimation).animationName));
  expect(running.filter((name) => name !== "version-refresh-spin")).toEqual([]);
  const backdrop = await page.locator(".np-strip").evaluate((element) => {
    const style = getComputedStyle(element);
    return style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter") || "none";
  });
  expect(backdrop).toBe("none");
});

/**
 * Follows a navigation link from the keyboard. A mouse click first waits for the link to hold still over
 * consecutive animation frames, and headless WebKit on macOS sometimes stops producing frames while the page
 * itself keeps working: a failing trace had one frame a second, then none for 27 seconds, so the click never
 * started. Focus and Enter need no frames, and a full page load instead of an in-app move still fails below.
 */
async function follow(page: Page, name: string) {
  const link = page.getByRole("navigation").getByRole("link", { name }).first();
  await expect(link).toBeVisible();
  await link.press("Enter");
}

test("moving from Now Playing to the dashboard keeps the live stream and shows it at once", async ({ page }) => {
  const streams = await fixture(page);
  await page.goto(`${baseUrl}/now-playing`);
  await expect(page.locator(".np-card")).toHaveCount(9);
  await follow(page, "Dashboard");
  await expect(page).toHaveURL(`${baseUrl}/`);
  const card = page.getByRole("region", { name: "Now Playing", exact: true });
  // A second stream would answer only after four seconds; the shared one already has the streams.
  await expect(card).toContainText("9 streams", { timeout: 1_500 });
  await expect(card).not.toContainText("Connecting to your media servers");
  await follow(page, "Now Playing");
  await expect(page).toHaveURL(`${baseUrl}/now-playing`);
  await expect(page.locator(".np-card")).toHaveCount(9, { timeout: 1_500 });
  expect(streams.opened).toBe(1);
});
