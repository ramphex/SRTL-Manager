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
  storagePolicyLabel: (policy: string) => policy,
  useLiveTimestamp: () => Date.parse("2026-11-02T10:00:00.000Z"),
  useModalLifecycle: () => ({ current: null }),
  useStorageLocations: () => ({})
}));

const { NowPlayingPage, StreamCard } = await import("../src/client/nowPlaying");

const media = (overrides: Partial<NowPlayingMediaInfo>): NowPlayingMediaInfo => ({ container: "mkv", videoCodec: "h264", resolution: "1080p", width: 1920, height: 1080, dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 12000, ...overrides });

function stream(overrides: Partial<NowPlayingStream> = {}): NowPlayingStream {
  return {
    id: "plex1:15", serverId: "plex1", serverKind: "plex", serverName: "Home Plex", sessionKey: "15", user: { id: "7", name: "sam" },
    mediaType: "episode", title: "The Fifth One", grandparentTitle: "Example Show", episodeLabel: "S02E05", year: 2021, posterUrl: null,
    player: { name: "Living Room", device: "SHIELD", platform: "Android", product: "Plex for Android (TV)", version: "10.0" },
    state: "playing", positionMs: 600_000, durationMs: 3_600_000, reportedAt: "2026-11-02T10:00:00.000Z",
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

  it("puts user, server and location in the bottom row, with the client IP only in a tooltip", () => {
    const card = renderCard(stream(), true);
    const footer = card.querySelector(".np-card-footer")!;
    expect(footer.querySelector(".np-footer-user")?.textContent).toBe("Usersam");
    expect(footer.querySelector(".np-footer-server")?.textContent).toBe("ServerHome Plex");
    const location = footer.querySelector(".np-footer-location")!;
    const trigger = location.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.textContent).toBe("WAN · Example City, Netherlands");
    const tooltip = document.getElementById(trigger.getAttribute("aria-describedby")!)!;
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    expect(tooltip.textContent).toBe("Client IP 198.51.100.23");
    // The address never shows anywhere else on the card, folded details included.
    const withoutTooltip = card.cloneNode(true) as HTMLElement;
    withoutTooltip.querySelector("[role=tooltip]")?.remove();
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
    expect(card.querySelector("[role=tooltip]")).toBeNull();
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

describe("Now Playing page", () => {
  it("remembers which cards are expanded for the session, folded by default", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
    const snapshot: NowPlayingSnapshot = {
      generatedAt: "2026-11-02T10:00:00.000Z",
      servers: [{ id: "plex1", name: "Home Plex", kind: "plex", status: "live", message: null, transport: "socket", plexPass: true, bandwidth: null, resources: null, lastUpdatedAt: null }],
      streams: [stream(), stream({ id: "plex1:16", sessionKey: "16", title: "Big Film", mediaType: "movie", grandparentTitle: null, episodeLabel: null })],
      summary: { transcodeHardware: 2, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 0, paused: 0, totalKbps: 21_000, totalIsEstimate: false }
    };
    const mount = () => {
      act(() => root.render(<QueryClientProvider client={new QueryClient()}><NowPlayingPage /></QueryClientProvider>));
      act(() => FakeEventSource.instance!.emit("sessions", snapshot));
      return [...container.querySelectorAll<HTMLButtonElement>(".np-details-toggle")];
    };
    let toggles = mount();
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    act(() => toggles[1]!.click());
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(JSON.parse(window.sessionStorage.getItem("srtl-now-playing-expanded")!)).toEqual(["plex1:16"]);

    // Leaving the page and coming back keeps the choice.
    act(() => root.unmount());
    root = createRoot(container);
    toggles = mount();
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    act(() => toggles[1]!.click());
    expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  });
});
