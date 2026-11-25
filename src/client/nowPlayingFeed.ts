import { useSyncExternalStore } from "react";
import type { NowPlayingHostEvent, NowPlayingSnapshot } from "../shared/nowPlaying";
import { applyHostEvent, type HostState } from "./nowPlayingPresentation";

export type NowPlayingConnection = "connecting" | "open" | "reconnecting";
export type NowPlayingFeedState = { snapshot: NowPlayingSnapshot | null; host: HostState; connection: NowPlayingConnection };

type FeedOptions = {
  url?: string;
  /** How long the stream stays open after the last screen using it goes away. */
  idleMs?: number;
  /** How long to wait before trying again after the server refused the stream outright. */
  retryMs?: number;
  createSource?: (url: string) => EventSource;
};

const initialState: NowPlayingFeedState = { snapshot: null, host: { info: null, samples: [] }, connection: "connecting" };

/**
 * One Now Playing stream shared by every screen that shows it.
 *
 * The Now Playing page and the dashboard card used to open a stream each, so moving between them closed one
 * and opened another. The new one started empty and showed "Connecting" until the server answered, which in
 * Safari over plain HTTP/1.1 can wait behind the dashboard's other requests for several seconds. Keeping one
 * stream, and holding it briefly after the last screen leaves, lets the next screen start from the latest data.
 */
export function createNowPlayingFeed(options: FeedOptions = {}) {
  const url = options.url ?? "/api/now-playing/events";
  const idleMs = options.idleMs ?? 15_000;
  const retryMs = options.retryMs ?? 10_000;
  const createSource = options.createSource ?? ((target: string) => new EventSource(target));
  const listeners = new Set<() => void>();
  let state = initialState;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const update = (next: Partial<NowPlayingFeedState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };

  const open = () => {
    const current = createSource(url);
    source = current;
    const live = () => source === current;
    current.addEventListener("open", () => { if (live()) update({ connection: "open" }); });
    current.addEventListener("sessions", (event) => {
      if (live()) update({ connection: "open", snapshot: JSON.parse((event as MessageEvent<string>).data) as NowPlayingSnapshot });
    });
    current.addEventListener("host", (event) => {
      if (!live()) return;
      const data = JSON.parse((event as MessageEvent<string>).data) as NowPlayingHostEvent;
      update({ host: applyHostEvent(state.host, data) });
    });
    current.addEventListener("error", () => {
      if (!live()) return;
      update({ connection: "reconnecting" });
      // The browser retries on its own unless the server refused the stream outright.
      if (current.readyState !== EventSource.CLOSED) return;
      source = null;
      retry = setTimeout(() => {
        retry = undefined;
        if (listeners.size) open();
      }, retryMs);
    });
  };

  const close = () => {
    if (idle) clearTimeout(idle);
    if (retry) clearTimeout(retry);
    idle = undefined;
    retry = undefined;
    source?.close();
    source = null;
    // Nobody is watching now; the next screen starts from "Connecting" instead of old streams.
    state = initialState;
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (idle) {
        clearTimeout(idle);
        idle = undefined;
      }
      if (!source && !retry) open();
      return () => {
        listeners.delete(listener);
        if (listeners.size || idle) return;
        idle = setTimeout(() => {
          idle = undefined;
          if (!listeners.size) close();
        }, idleMs);
      };
    },
    /** Closes the stream at once; tests use it to start each case clean. */
    close
  };
}

export const nowPlayingFeed = createNowPlayingFeed();

export function useNowPlayingEvents(): NowPlayingFeedState {
  return useSyncExternalStore(nowPlayingFeed.subscribe, nowPlayingFeed.getState);
}
