import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNowPlayingFeed } from "../src/client/nowPlayingFeed";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static created: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  constructor(readonly url: string) { FakeEventSource.created.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent<string>); }
}

const snapshot = { generatedAt: "2026-11-24T10:00:00.000Z", servers: [], streams: [], summary: { transcodeHardware: 0, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 0, paused: 0, totalKbps: 0, totalIsEstimate: false } };

function feed() {
  return createNowPlayingFeed({ idleMs: 1_000, retryMs: 5_000, createSource: (url) => new FakeEventSource(url) as unknown as EventSource });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.created = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared Now Playing feed", () => {
  it("opens one stream however many screens watch it", () => {
    const live = feed();
    const stopPage = live.subscribe(() => undefined);
    const stopCard = live.subscribe(() => undefined);
    expect(FakeEventSource.created).toHaveLength(1);
    stopPage();
    stopCard();
  });

  it("hands the latest streams to the next screen when moving between pages", () => {
    const live = feed();
    const stopPage = live.subscribe(() => undefined);
    FakeEventSource.created[0]!.emit("open");
    FakeEventSource.created[0]!.emit("sessions", snapshot);
    // The page unmounts before the dashboard mounts, as a route change does.
    stopPage();
    vi.advanceTimersByTime(500);
    const updates = vi.fn();
    const stopCard = live.subscribe(updates);
    expect(FakeEventSource.created).toHaveLength(1);
    expect(FakeEventSource.created[0]!.closed).toBe(false);
    expect(live.getState()).toMatchObject({ connection: "open", snapshot });
    FakeEventSource.created[0]!.emit("sessions", snapshot);
    expect(updates).toHaveBeenCalledTimes(1);
    stopCard();
  });

  it("closes the stream once nothing has watched it for a while, and starts clean next time", () => {
    const live = feed();
    const stop = live.subscribe(() => undefined);
    FakeEventSource.created[0]!.emit("sessions", snapshot);
    stop();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.created[0]!.closed).toBe(true);
    expect(live.getState()).toMatchObject({ connection: "connecting", snapshot: null });
    const again = live.subscribe(() => undefined);
    expect(FakeEventSource.created).toHaveLength(2);
    again();
  });

  it("keeps the browser's own reconnect, and retries itself only after the server refused the stream", () => {
    const live = feed();
    const stop = live.subscribe(() => undefined);
    const first = FakeEventSource.created[0]!;
    first.emit("error");
    expect(live.getState().connection).toBe("reconnecting");
    vi.advanceTimersByTime(5_000);
    expect(FakeEventSource.created).toHaveLength(1);
    first.readyState = FakeEventSource.CLOSED;
    first.emit("error");
    vi.advanceTimersByTime(4_999);
    expect(FakeEventSource.created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.created).toHaveLength(2);
    // Events from the refused stream no longer count.
    first.emit("sessions", snapshot);
    expect(live.getState().snapshot).toBeNull();
    stop();
  });
});
