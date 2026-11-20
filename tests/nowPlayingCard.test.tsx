// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlayingMediaInfo, NowPlayingSnapshot, NowPlayingStream } from "../src/shared/nowPlaying";

const access = vi.hoisted(() => ({ canStop: true }));

vi.mock("../src/client/App", () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("../src/client/access", () => ({ useAccess: () => ({ can: (permission: string) => permission === "streams.stop" ? access.canStop : false }) }));
vi.mock("../src/client/mediaServersRequired", () => ({ MediaServersRequired: () => null }));
vi.mock("../src/client/appShared", () => ({
  defaultUserPreferences: { timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440, nowPlayingHiddenServers: [] },
  storagePolicyLabel: (policy: string) => policy,
  useLiveTimestamp: () => Date.parse("2026-11-02T10:00:00.000Z"),
  useModalLifecycle: () => ({ current: null }),
  useStorageLocations: () => ({}),
  useUserPreferences: () => ({ timeFormat: "12h" })
}));

const { NowPlayingPage, StreamCard } = await import("../src/client/nowPlaying");

const media = (overrides: Partial<NowPlayingMediaInfo>): NowPlayingMediaInfo => ({ container: "mkv", videoCodec: "h264", resolution: "1080p", width: 1920, height: 1080, dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 12000, ...overrides });

function stream(overrides: Partial<NowPlayingStream> = {}): NowPlayingStream {
  return {
    id: "plex1:15", serverId: "plex1", serverKind: "plex", serverName: "Home Plex", sessionKey: "15", user: { id: "7", name: "sam" },
    mediaType: "episode", title: "The Fifth One", grandparentTitle: "Example Show", episodeLabel: "S02E05", year: 2021, posterUrl: null,
    player: { name: "Living Room", device: "SHIELD", platform: "Android", product: "Plex for Android (TV)", version: "10.0" },
    state: "playing", positionMs: 600_000, durationMs: 3_600_000, bufferedMs: null, reportedAt: "2026-11-02T10:00:00.000Z",
    playMethod: "transcode", videoDecision: "transcode", audioDecision: "transcode", subtitle: null,
    source: media({ videoCodec: "hevc", resolution: "4K", width: 3840, height: 2160, dynamicRange: "HDR10" }), output: media({ audioCodec: "aac", audioChannels: 2 }),
    transcode: { engine: "hardware", hardwareDecode: "nvdec", hardwareEncode: "nvenc", speed: 3.4, throttled: false, reasons: ["Video codec hevc to h264"], reasonsDerived: true },
    bandwidth: { kbps: 10_500, kind: "nominal" },
    network: { location: "wan", ip: "198.51.100.23", relayed: false, secure: true, geo: { city: "Example City", region: null, country: "Netherlands", code: "NL" } },
    srtl: { status: "remote", locationName: "Remote storage", policy: null }, stop: { available: true, reason: null },
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  access.canStop = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

function renderCard(value: NowPlayingStream, expanded = false, handlers: { onToggle?: (id: string) => void; onStop?: (stream: NowPlayingStream) => void } = {}) {
  act(() => root.render(<StreamCard stream={value} now={Date.parse("2026-11-02T10:00:00.000Z")} expanded={expanded} onToggle={handlers.onToggle ?? (() => undefined)} onStop={handlers.onStop ?? (() => undefined)} />));
  return container.querySelector("article")!;
}

const visible = (element: Element | null) => Boolean(element) && !element!.closest("[hidden]");

describe("Now Playing stream card", () => {
  it("shows the played part over a lighter buffered part, and time left with the total and end time behind it", () => {
    const card = renderCard(stream({ playMethod: "transcode", bufferedMs: 1_800_000 }));
    const bar = card.querySelector(".np-progress")!;
    const playedWidth = (bar.querySelector(".np-progress-played") as HTMLElement).style.width;
    expect(playedWidth).toMatch(/%$/);
    expect(Number.parseFloat(playedWidth)).toBeCloseTo((600_000 / 3_600_000) * 100, 3);
    expect((bar.querySelector(".np-progress-buffer") as HTMLElement).style.width).toBe("50%");
    expect(bar.getAttribute("title")).toBe("Transcoded to 30:00, 20:00 ahead");
    expect(bar.getAttribute("aria-valuetext")).toBe("10:00 of 1:00:00. Transcoded to 30:00, 20:00 ahead");
    const times = card.querySelector(".np-progress-times")!;
    expect(times.firstElementChild?.textContent).toBe("10:00");
    const left = times.querySelector(".np-time-left")!;
    expect(left.querySelector(".text-tooltip-trigger")?.textContent).toBe("-50:00");
    const panel = left.querySelector("[role=tooltip]")!;
    expect(panel.querySelector(".np-time-total")?.textContent).toBe("Total 1:00:00");
    const endsAt = new Date(Date.parse("2026-11-02T10:00:00.000Z") + 3_000_000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    expect(panel.textContent).toContain(`Ends at ${endsAt}`);
  });

  it("has no buffered part when the server does not report one, and no time left without a duration", () => {
    expect(renderCard(stream({ bufferedMs: null })).querySelector(".np-progress-buffer")).toBeNull();
    const card = renderCard(stream({ durationMs: null, bufferedMs: null }));
    expect(card.querySelector(".np-time-left")).toBeNull();
    expect(card.querySelector(".np-progress-times")?.textContent).toContain("--:--");
  });

  it("starts folded: one summary line with bandwidth and quality, details hidden", () => {
    const card = renderCard(stream());
    expect(card.querySelector(".np-summary-text")?.textContent).toBe("10.5 Mbps · 4K → 1080p");
    expect(card.querySelector(".np-summary-line")?.textContent).toContain("Transcode (HW)");
    const toggle = card.querySelector<HTMLButtonElement>(".np-details-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Stream details");
    const details = card.querySelector(".np-details")!;
    expect(toggle.getAttribute("aria-controls")).toBe(details.id);
    expect(visible(details)).toBe(false);
  });

  it("shows the full details and hides the summary line when expanded", () => {
    const onToggle = vi.fn();
    const card = renderCard(stream(), true, { onToggle });
    expect(card.querySelector(".np-summary-line")).toBeNull();
    expect(visible(card.querySelector(".np-details"))).toBe(true);
    expect(card.querySelector(".np-details")?.textContent).toContain("GPU (nvdec decode, nvenc encode) · 3.4x");
    const toggle = card.querySelector<HTMLButtonElement>(".np-details-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle.click());
    expect(onToggle).toHaveBeenCalledWith("plex1:15");
  });

  it("shows the SRTL source badge only for files on local or remote storage", () => {
    expect(renderCard(stream()).querySelector(".np-badge-remote")?.textContent).toBe("Remote storage");
    expect(renderCard(stream({ srtl: { status: "local", locationName: "Home NAS", policy: null } })).querySelector(".np-badge-local")?.textContent).toBe("Home NAS");
    for (const status of ["unlinked", "broken", "unknown"] as const) {
      const card = renderCard(stream({ srtl: { status, locationName: null, policy: null } }));
      expect(card.querySelectorAll(".np-badges .np-badge")).toHaveLength(1);
      expect(card.querySelector(".np-badge-state")).not.toBeNull();
    }
  });

  it("puts user, server and location in the bottom row, with the client IP only in a tooltip", () => {
    const card = renderCard(stream(), true);
    const footer = card.querySelector(".np-card-footer")!;
    expect(footer.querySelector(".np-footer-user")?.textContent).toBe("Usersam");
    expect(footer.querySelector(".np-footer-server .np-footer-text")?.textContent).toBe("Home Plex");
    // The server is named in text, so its icon is decorative and adds no hover tooltip of its own.
    const icon = footer.querySelector(".np-footer-server svg.server-kind-plex")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.querySelector("title")).toBeNull();
    const player = footer.querySelector(".np-footer-player dd")!;
    expect(player.textContent).toBe("Plex for Android (TV) · Living Room");
    expect(player.getAttribute("title")).toBe("Plex for Android (TV) · Living Room · SHIELD · Android");
    expect(card.querySelector(".np-card-player")).toBeNull();
    const location = footer.querySelector(".np-footer-location")!;
    const trigger = location.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.textContent).toBe("WAN · Example City, Netherlands");
    const tooltip = document.getElementById(trigger.getAttribute("aria-describedby")!)!;
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(tooltip.textContent).toBe("Client IP 198.51.100.23");
    // The address never shows anywhere else on the card, folded details included.
    const withoutTooltip = card.cloneNode(true) as HTMLElement;
    withoutTooltip.querySelector(".np-footer-location [role=tooltip]")?.remove();
    expect(withoutTooltip.textContent).not.toContain("198.51.100.23");
    // The user and server are not repeated above the bottom row.
    expect(card.querySelector(".np-card-body")?.textContent).not.toContain("Home Plex");
    act(() => trigger.click());
    expect(location.querySelector(".info-tooltip")?.classList.contains("is-open")).toBe(true);
  });

  it("shows the location without a tooltip when there is no client address", () => {
    const card = renderCard(stream({ network: { location: "lan", ip: null, relayed: false, secure: null, geo: null } }));
    const location = card.querySelector(".np-footer-location")!;
    expect(location.textContent).toBe("LocationLAN");
    expect(location.querySelector("button")).toBeNull();
    expect(location.querySelector("[role=tooltip]")).toBeNull();
  });

  it("stops with a small icon button named Terminate the stream", () => {
    const onStop = vi.fn();
    const value = stream();
    const card = renderCard(value, false, { onStop });
    const stop = card.querySelector<HTMLButtonElement>("button.np-stop-button")!;
    expect(stop.getAttribute("aria-label")).toBe("Terminate the stream");
    expect(stop.getAttribute("title")).toBe("Terminate the stream");
    expect(stop.textContent).toBe("");
    expect(stop.querySelector("svg")).not.toBeNull();
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledWith(value);
    access.canStop = false;
    expect(renderCard(value).querySelector(".np-stop-button")).toBeNull();
  });
});

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  constructor() { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  emit(type: string, data: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent<string>); }
}

const servers: NowPlayingSnapshot["servers"] = [
  { id: "plex1", name: "Home Plex", kind: "plex", status: "live", message: null, transport: "socket", plexPass: true, bandwidth: null, resources: null, lastUpdatedAt: null },
  { id: "jf1", name: "Jellyfin", kind: "jellyfin", status: "live", message: null, transport: "socket", plexPass: null, bandwidth: null, resources: null, lastUpdatedAt: null }
];

function pageSnapshot(extra: { servers?: NowPlayingSnapshot["servers"]; streams?: NowPlayingStream[] } = {}): NowPlayingSnapshot {
  const streams = [
    stream(),
    stream({ id: "plex1:16", sessionKey: "16", title: "Big Film", mediaType: "movie", grandparentTitle: null, episodeLabel: null }),
    stream({ id: "jf1:a", serverId: "jf1", serverKind: "jellyfin", serverName: "Jellyfin", sessionKey: "a", title: "Example Movie", mediaType: "movie", grandparentTitle: null, episodeLabel: null, playMethod: "directPlay", videoDecision: "directPlay", audioDecision: "directPlay", output: null, transcode: null, bandwidth: { kbps: 20_000, kind: "estimate" } }),
    ...(extra.streams ?? [])
  ];
  return {
    generatedAt: "2026-11-02T10:00:00.000Z", servers: [...servers, ...(extra.servers ?? [])], streams,
    summary: { transcodeHardware: 2, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 1, paused: 0, totalKbps: 41_000, totalIsEstimate: true }
  };
}

// A stand-in for the preferences route that keeps what was saved, like the signed-in account's settings.
function preferencesServer(initial: Record<string, unknown> = { timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440, nowPlayingHiddenServers: [] }) {
  let stored = initial;
  const saves: unknown[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/settings/user-preferences") {
      if (init?.method === "PUT") {
        stored = JSON.parse(String(init.body)) as Record<string, unknown>;
        saves.push(stored);
      }
      return json(stored);
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { saves, get stored() { return stored; } };
}

function mountPage(snapshot: NowPlayingSnapshot) {
  act(() => root.render(<QueryClientProvider client={new QueryClient()}><NowPlayingPage /></QueryClientProvider>));
  act(() => FakeEventSource.instance!.emit("sessions", snapshot));
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const cardTitles = () => [...container.querySelectorAll("article h3")].map((heading) => heading.textContent);
const serverToggle = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".np-server-toggle")].find((button) => button.textContent?.includes(name))!;
const pill = (label: string) => container.querySelector(`[aria-label^="${label}:"]`)?.getAttribute("aria-label");

function remount() {
  act(() => root.unmount());
  root = createRoot(container);
}

describe("Now Playing page", () => {
  beforeEach(() => { vi.stubGlobal("EventSource", FakeEventSource); });

  it("remembers which cards are expanded for the session, folded by default", async () => {
    preferencesServer();
    mountPage(pageSnapshot());
    await settle();
    let toggles = [...container.querySelectorAll<HTMLButtonElement>(".np-details-toggle")];
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
    act(() => toggles[1]!.click());
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]);
    expect(JSON.parse(window.sessionStorage.getItem("srtl-now-playing-expanded")!)).toEqual(["plex1:16"]);

    // Leaving the page and coming back keeps the choice.
    remount();
    mountPage(pageSnapshot());
    await settle();
    toggles = [...container.querySelectorAll<HTMLButtonElement>(".np-details-toggle")];
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]);
    act(() => toggles[1]!.click());
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
  });

  it("shows every server by default, each as a pressed toggle with its server type icon", async () => {
    preferencesServer({ timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 });
    mountPage(pageSnapshot());
    await settle();
    expect(cardTitles()).toEqual(["Example Show", "Big Film", "Example Movie"]);
    expect(serverToggle("Home Plex").getAttribute("aria-pressed")).toBe("true");
    expect(serverToggle("Jellyfin").getAttribute("aria-pressed")).toBe("true");
    expect(serverToggle("Home Plex").querySelector("svg[role=img]")?.getAttribute("aria-label")).toBe("Plex");
    expect(serverToggle("Jellyfin").querySelector("svg[role=img]")?.getAttribute("aria-label")).toBe("Jellyfin");
    const footers = [...container.querySelectorAll(".np-footer-server svg")].map((icon) => icon.getAttribute("class"));
    expect(footers).toEqual(["server-kind-icon server-kind-plex", "server-kind-icon server-kind-plex", "server-kind-icon server-kind-jellyfin"]);
    expect(container.querySelector(".np-footer-server title")).toBeNull();
    expect(pill("Streams")).toBe("Streams: 3");
    expect(pill("Direct play")).toBe("Direct play: 1");
  });

  it("shows only the server icon while each kind has one server, and names every card once a kind has two", async () => {
    preferencesServer();
    mountPage(pageSnapshot());
    await settle();
    const serverCells = () => [...container.querySelectorAll(".np-footer-server")];
    expect(container.querySelectorAll(".np-server-name")).toHaveLength(0);
    const trigger = serverCells()[0]!.querySelector<HTMLButtonElement>(".np-server-tooltip button")!;
    expect(trigger.querySelector(".sr-only")?.textContent).toBe("Home Plex");
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("Home Plex");

    remount();
    preferencesServer();
    mountPage(pageSnapshot({ servers: [{ ...servers[0]!, id: "plex2", name: "Cabin Plex" }] }));
    await settle();
    expect(serverCells().map((cell) => cell.querySelector(".np-server-name .np-footer-text")?.textContent)).toEqual(["Home Plex", "Home Plex", "Jellyfin"]);
    expect(container.querySelectorAll(".np-server-tooltip")).toHaveLength(0);
  });

  it("hides a server's streams when it is turned off, and keeps that choice for the account", async () => {
    const preferences = preferencesServer();
    mountPage(pageSnapshot());
    await settle();
    act(() => serverToggle("Jellyfin").click());
    await settle();
    expect(serverToggle("Jellyfin").getAttribute("aria-pressed")).toBe("false");
    expect(cardTitles()).toEqual(["Example Show", "Big Film"]);
    // The pills count only the servers shown.
    expect(pill("Streams")).toBe("Streams: 2");
    // A count of 0 hides its pill.
    expect(pill("Direct play")).toBeUndefined();
    expect(pill("Bandwidth")).toBe("Bandwidth: 21.0 Mbps");
    expect(preferences.saves).toEqual([expect.objectContaining({ timeFormat: "12h", nowPlayingHiddenServers: ["jf1"] })]);

    // A new visit reads the account's saved choice.
    remount();
    mountPage(pageSnapshot());
    await settle();
    expect(serverToggle("Jellyfin").getAttribute("aria-pressed")).toBe("false");
    expect(cardTitles()).toEqual(["Example Show", "Big Film"]);

    act(() => serverToggle("Jellyfin").click());
    await settle();
    expect(cardTitles()).toEqual(["Example Show", "Big Film", "Example Movie"]);
    expect(preferences.stored).toMatchObject({ nowPlayingHiddenServers: [] });
  });

  it("starts a server added later as shown", async () => {
    preferencesServer({ timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440, nowPlayingHiddenServers: ["jf1"] });
    const added = { ...servers[0]!, id: "plex2", name: "Cabin Plex" };
    mountPage(pageSnapshot({ servers: [added], streams: [stream({ id: "plex2:1", serverId: "plex2", serverName: "Cabin Plex", sessionKey: "1", title: "Cabin Film", mediaType: "movie", grandparentTitle: null, episodeLabel: null })] }));
    await settle();
    expect(serverToggle("Cabin Plex").getAttribute("aria-pressed")).toBe("true");
    expect(serverToggle("Jellyfin").getAttribute("aria-pressed")).toBe("false");
    expect(cardTitles()).toEqual(["Example Show", "Big Film", "Cabin Film"]);
  });

  it("says no servers are selected when every server is off", async () => {
    preferencesServer({ timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440, nowPlayingHiddenServers: ["plex1"] });
    mountPage(pageSnapshot());
    await settle();
    expect(container.querySelector(".np-empty")).toBeNull();
    act(() => serverToggle("Jellyfin").click());
    await settle();
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.querySelector(".np-empty")?.textContent).toContain("No servers selected");
    // Host load is not filtered.
    expect(container.querySelector("[aria-label='Quick glance']")).not.toBeNull();
  });
});
