import { expect, test, type Page } from "@playwright/test";
import type { MediaServer } from "../../src/shared/mediaServers";
import type { NowPlayingHostEvent, NowPlayingMediaInfo, NowPlayingServerState, NowPlayingSnapshot, NowPlayingStream } from "../../src/shared/nowPlaying";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

const connectedServers: MediaServer[] = [
  { id: "plex1", kind: "plex", name: "Home Plex", url: "http://media.example.com:32400", hasToken: true, prefixMappings: [], machineIdentifier: "m1", accountName: "alex_03", version: "1.43.0", lastCheckedAt: "2026-11-02T10:00:00.000Z", lastError: null },
  { id: "jf1", kind: "jellyfin", name: "Jellyfin", url: "http://media.example.com:8096", hasToken: true, prefixMappings: [], machineIdentifier: null, accountName: null, version: "10.10.3", lastCheckedAt: "2026-11-02T10:00:00.000Z", lastError: null }
];

const media = (overrides: Partial<NowPlayingMediaInfo>): NowPlayingMediaInfo => ({ container: "mkv", videoCodec: "h264", resolution: "1080p", width: 1920, height: 1080, dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 12000, ...overrides });

function stream(overrides: Partial<NowPlayingStream> & Pick<NowPlayingStream, "sessionKey" | "title" | "playMethod">): NowPlayingStream {
  const serverId = overrides.serverId ?? "plex1";
  return {
    id: `${serverId}:${overrides.sessionKey}`, serverId, serverKind: serverId === "jf1" ? "jellyfin" : "plex", serverName: serverId === "jf1" ? "Jellyfin" : "Home Plex",
    user: { id: "1", name: "alex_03" }, mediaType: "movie", grandparentTitle: null, episodeLabel: null, year: 2021, posterUrl: `/api/now-playing/poster/${"p".repeat(31)}${overrides.sessionKey.slice(-1)}`,
    player: { name: "Living Room", device: "SHIELD", platform: "Android", product: "Plex for Android (TV)", version: "10.0" },
    state: "playing", positionMs: 600_000, durationMs: 7_200_000, reportedAt: new Date().toISOString(),
    videoDecision: "directPlay", audioDecision: "directPlay", subtitle: null, source: media({}), output: null, transcode: null,
    bandwidth: { kbps: 12_500, kind: "nominal" }, network: { location: "lan", ip: "192.168.1.40", relayed: false, secure: true, geo: null },
    srtl: { status: "local", locationName: "Home NAS", policy: "location_1" }, stop: { available: true, reason: null },
    ...overrides
  };
}

function streams(plexPass: boolean): NowPlayingStream[] {
  const plexStop = plexPass ? { available: true, reason: null } : { available: false, reason: "Stopping Plex streams needs an active Plex Pass on the server owner's account." };
  return [
    stream({
      sessionKey: "15", title: "The Fifth One", mediaType: "episode", grandparentTitle: "Example Show", episodeLabel: "S02E05", playMethod: "transcode", user: { id: "7", name: "sam" },
      videoDecision: "transcode", audioDecision: "transcode", source: media({ videoCodec: "hevc", resolution: "4K", dynamicRange: "HDR10", audioCodec: "truehd", audioChannels: 8 }),
      output: media({ container: "mp4", audioCodec: "aac", audioChannels: 2, bitrateKbps: 10_000 }), subtitle: { decision: "burn", codec: "pgs", language: "English" },
      transcode: { engine: "hardware", hardwareDecode: "nvdec", hardwareEncode: "nvenc", speed: 3.4, throttled: false, reasons: ["Subtitle burn-in", "Video codec hevc to h264"], reasonsDerived: true },
      bandwidth: { kbps: 10_500, kind: "nominal" }, network: { location: "wan", ip: "198.51.100.23", relayed: false, secure: true, geo: { city: "Example City", region: null, country: "Netherlands", code: "NL" } },
      srtl: { status: "remote", locationName: "Debrid", policy: null }, stop: plexStop
    }),
    stream({
      sessionKey: "21", title: "Big Film", playMethod: "transcode", state: "paused", videoDecision: "copy", audioDecision: "transcode",
      source: media({ videoCodec: "hevc", resolution: "4K", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioChannels: 8 }), output: media({ videoCodec: "hevc", resolution: "4K", dynamicRange: "Dolby Vision", audioCodec: "ac3" }),
      transcode: { engine: "cpu", hardwareDecode: null, hardwareEncode: null, speed: 0.6, throttled: true, reasons: ["Audio codec truehd to ac3"], reasonsDerived: true }, stop: plexStop
    }),
    stream({ sessionKey: "30", title: "Old Film", playMethod: "directStream", videoDecision: "copy", audioDecision: "copy", source: media({ container: "avi", videoCodec: "mpeg4", resolution: "SD" }), output: media({ videoCodec: "mpeg4", resolution: "SD" }), stop: plexStop }),
    stream({
      serverId: "jf1", sessionKey: "jf-session-1", title: "Example Movie", playMethod: "directPlay", user: { id: "u1", name: "alex_03" },
      player: { name: "Firefox", device: null, platform: null, product: "Jellyfin Web", version: "10.10.3" }, bandwidth: { kbps: 54_000, kind: "estimate" }
    })
  ];
}

function snapshot(plexPass: boolean): NowPlayingSnapshot {
  const servers: NowPlayingServerState[] = [
    { id: "plex1", name: "Home Plex", kind: "plex", status: "live", message: null, transport: "socket", plexPass, bandwidth: { lanBps: 1_500_000, wanBps: 1_300_000 }, resources: { hostCpu: 21, processCpu: 9, hostMemory: 40, processMemory: 3 }, lastUpdatedAt: new Date().toISOString() },
    { id: "jf1", name: "Jellyfin", kind: "jellyfin", status: "live", message: null, transport: "socket", plexPass: null, bandwidth: null, resources: null, lastUpdatedAt: new Date().toISOString() }
  ];
  return {
    generatedAt: new Date().toISOString(), servers, streams: streams(plexPass),
    summary: { transcodeHardware: 1, transcodeCpu: 1, transcodeUnknown: 0, directStream: 1, directPlay: 1, paused: 1, totalKbps: 77_000, totalIsEstimate: true }
  };
}

function host(): NowPlayingHostEvent {
  const start = Date.now() - 30 * 3000;
  return {
    info: { networkScope: "host", interfaces: ["ens18"], gpuAvailable: true, sampleIntervalMs: 3000 },
    samples: Array.from({ length: 30 }, (_value, index) => ({
      at: new Date(start + index * 3000).toISOString(), cpuPercent: 20 + (index % 7) * 3, memoryUsedBytes: 6 * 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3,
      networkInBps: index ? 4_000_000 + index * 10_000 : null, networkOutBps: index ? 2_500_000 : null,
      gpus: [{ index: 0, name: "NVIDIA RTX A2000 12GB", utilization: 18, encoder: 31, decoder: 22, memoryUsedMb: 1400, memoryTotalMb: 12282, encoderSessions: 1, temperatureC: 50 }]
    }))
  };
}

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

// What the server's restricted view sends a moderator: no address, and no location field at all.
function restrictedSnapshot(value: NowPlayingSnapshot): NowPlayingSnapshot {
  return {
    ...value,
    streams: value.streams.map((stream) => {
      const { geo: _geo, ...network } = stream.network;
      return { ...stream, network: { ...network, ip: null } } as unknown as NowPlayingSnapshot["streams"][number];
    })
  };
}

async function fixture(page: Page, options: { servers?: MediaServer[]; plexPass?: boolean; moderator?: boolean } = {}) {
  const stops: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let response: unknown = [];
    if (url.pathname === "/api/now-playing/events") {
      const body = `retry: 600000\n\nevent: sessions\ndata: ${JSON.stringify(options.moderator ? restrictedSnapshot(snapshot(options.plexPass ?? true)) : snapshot(options.plexPass ?? true))}\n\nevent: host\ndata: ${JSON.stringify(host())}\n\n`;
      await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }, body });
      return;
    }
    if (url.pathname.startsWith("/api/now-playing/poster/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: pixel });
      return;
    }
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: options.moderator ? "moderator" : "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") response = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") response = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") response = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Debrid", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") response = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.3", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      response = { currentVersion: "0.1.4-beta.3", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/media-servers") response = { servers: options.servers ?? connectedServers, limit: 10 };
    else if (url.pathname === "/api/now-playing/settings") response = { geoLookup: true };
    else if (url.pathname === "/api/now-playing/stop") {
      stops.push(request.postDataJSON());
      response = { result: "stopped", message: "The stream has stopped." };
    }
    await route.fulfill({ status: 200, json: response });
  });
  return { stops };
}

async function openNowPlaying(page: Page) {
  await page.goto(`${baseUrl}/now-playing`);
  await expect(page.getByRole("heading", { name: "Now Playing", level: 1 })).toBeVisible();
}

test("asks for a media server when none is connected", async ({ page }) => {
  await fixture(page, { servers: [{ ...connectedServers[0]!, hasToken: false }] });
  await openNowPlaying(page);
  const empty = page.getByRole("status", { name: "No media server connected" });
  await expect(empty).toBeVisible();
  await expect(empty.getByRole("link", { name: "Open Media servers" })).toHaveAttribute("href", "/settings/media-servers");
  await expect(page.getByRole("region", { name: "Quick glance" })).toHaveCount(0);
});

test("pins the quick-glance strip with stream pills and host cards", async ({ page }) => {
  await fixture(page);
  await openNowPlaying(page);
  const strip = page.getByRole("region", { name: "Quick glance" });
  for (const label of ["HW transcode: 1", "CPU transcode: 1", "Direct stream: 1", "Direct play: 1", "Bandwidth (est.): ≈ 77.0 Mbps", "Paused: 1"]) {
    await expect(strip.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(strip.getByRole("region", { name: "CPU" })).toContainText("Plex reports host 21%");
  await expect(strip.getByRole("region", { name: "RAM" })).toContainText("6.0 GB of 16.0 GB");
  const network = strip.getByRole("region", { name: "Network (host total)" });
  await expect(network).toContainText("Plex streaming: LAN 12.0 Mbps · WAN 10.4 Mbps");
  await expect(strip.getByRole("region", { name: "NVIDIA RTX A2000 12GB" })).toContainText("1 enc sessions");
  await expect(strip.getByRole("img", { name: "CPU over the last few minutes" })).toBeVisible();

  // The strip stays at the top of the viewport while the cards scroll beneath it.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.mouse.wheel(0, 2000);
  await expect.poll(async () => Math.round((await strip.boundingBox())?.y ?? -1)).toBe(0);
});

test("shows one card per stream with play method, source badge, and details", async ({ page }) => {
  await fixture(page);
  await openNowPlaying(page);
  const cards = page.getByRole("article");
  await expect(cards).toHaveCount(4);
  const hw = page.getByRole("article", { name: "Example Show — sam" });
  await expect(hw).toContainText("S02E05 · The Fifth One");
  await expect(hw).toContainText("Transcode (HW)");
  await expect(hw).toContainText("HEVC 4K HDR10 → H.264 1080p");
  await expect(hw).toContainText("burned in");
  await expect(hw).toContainText("GPU (nvdec decode, nvenc encode) · 3.4x");
  await expect(hw).toContainText("Why (derived)");
  await expect(hw).toContainText("198.51.100.23");
  await expect(hw).toContainText("Example City, Netherlands");
  await expect(hw).toContainText("Debrid");
  await expect(hw).toContainText("WAN");
  const cpu = page.getByRole("article", { name: "Big Film — alex_03" });
  await expect(cpu).toContainText("Transcode (CPU)");
  await expect(cpu).toContainText("Paused");
  await expect(cpu).toContainText("throttled");
  await expect(cpu).toContainText("(paused, not counted)");
  await expect(page.getByRole("article", { name: "Old Film — alex_03" })).toContainText("Direct stream");
  const direct = page.getByRole("article", { name: "Example Movie — alex_03" });
  await expect(direct).toContainText("Direct play");
  await expect(direct).toContainText("Home NAS");
  await expect(direct).toContainText("(estimate)");
  await expect(page.getByRole("list", { name: "Media servers" })).toContainText("Home Plex");
});

test("shows a moderator the viewer, with no address, location or Stop", async ({ page }) => {
  await fixture(page, { moderator: true });
  await openNowPlaying(page);
  const hw = page.getByRole("article", { name: "Example Show — sam" });
  await expect(hw).toContainText("sam");
  await expect(hw).toContainText("Transcode (HW)");
  await expect(hw).not.toContainText("198.51.100.23");
  await expect(hw.getByText("Address", { exact: true })).toHaveCount(0);
  await expect(hw.getByText("Location", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Example City");
  await expect(page.locator("body")).not.toContainText("Netherlands");
  await expect(hw.locator(".np-geo")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Stop stream/ })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("192.168.1.40");
});

test("stops a stream after confirming an edited message", async ({ page }) => {
  const { stops } = await fixture(page);
  await openNowPlaying(page);
  await page.getByRole("button", { name: "Stop stream for sam" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop sam's stream?" });
  await expect(dialog).toBeVisible();
  const message = dialog.getByRole("textbox");
  await expect(message).toHaveValue("This stream was stopped by the server administrator.");
  await message.fill("Server maintenance in 5 minutes.");
  await dialog.getByRole("button", { name: "Stop stream", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("The stream has stopped.");
  expect(stops).toEqual([{ serverId: "plex1", sessionKey: "15", message: "Server maintenance in 5 minutes." }]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("hides Stop on Plex streams without Plex Pass", async ({ page }) => {
  await fixture(page, { plexPass: false });
  await openNowPlaying(page);
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Stop stream for sam" })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Big Film — alex_03" }).getByRole("button", { name: /Stop/ })).toHaveCount(0);
  // Jellyfin streams keep their Stop button.
  await expect(page.getByRole("article", { name: "Example Movie — alex_03" }).getByRole("button", { name: /Stop stream/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Media servers" })).toContainText("Stop needs Plex Pass");
});

test("fits a phone screen without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  await page.goto(`${baseUrl}/now-playing`);
  await expect(page.getByRole("article")).toHaveCount(4);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
