import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activatePwaUpdate, clearPendingPwaUpdate, getPendingPwaUpdate, pwaRegistrationErrorEvent, pwaUpdateReadyEvent, registerPwaServiceWorker } from "../src/client/pwa";

type WorkerListener = (event: Record<string, unknown>) => void;

function workerListeners() {
  const listeners = new Map<string, WorkerListener>();
  const cacheStorage = {
    open: vi.fn().mockResolvedValue({ addAll: vi.fn(), match: vi.fn(), put: vi.fn() }),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true)
  };
  const claim = vi.fn();
  const context = vm.createContext({
    URL,
    caches: cacheStorage,
    fetch: vi.fn(),
    self: {
      location: { origin: "https://srtl.test" },
      clients: { claim },
      skipWaiting: vi.fn(),
      addEventListener: (type: string, listener: WorkerListener) => listeners.set(type, listener)
    }
  });
  return { cacheStorage, claim, context, listeners };
}

describe("PWA foundation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defines a root-scoped manifest with only self-hosted icons", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "manifest.webmanifest"), "utf8")) as {
      id: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };

    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(manifest.icons.every((icon) => icon.src.startsWith("/") && !icon.src.startsWith("//"))).toBe(true);
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    await Promise.all(manifest.icons.map((icon) => fs.access(path.join(process.cwd(), "public", icon.src.slice(1)))));
  });

  it("does not intercept API or documentation requests in the service worker", async () => {
    const { context, listeners } = workerListeners();
    const source = await fs.readFile(path.join(process.cwd(), "public", "service-worker.js"), "utf8");
    new vm.Script(source).runInContext(context);
    const fetchListener = listeners.get("fetch");
    expect(fetchListener).toBeTypeOf("function");

    for (const pathname of ["/api/jobs", "/documentation", "/documentation/static/index.css", "/private-data.json"]) {
      const respondWith = vi.fn();
      fetchListener?.({
        request: { method: "GET", mode: "cors", url: `https://srtl.test${pathname}` },
        respondWith
      });
      expect(respondWith).not.toHaveBeenCalled();
    }
  });

  it("provides build placeholders for revisioned caches and generated assets", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "public", "service-worker.js"), "utf8");
    expect(source).toContain('const BUILD_REVISION = "__SRTL_BUILD_REVISION__";');
    expect(source).toContain("const GENERATED_ASSET_URLS = /* __SRTL_GENERATED_ASSETS__ */ [];");
    expect(source).toContain("`${CACHE_PREFIX}${BUILD_REVISION}`");
  });

  it("retains the current and immediately previous application caches", async () => {
    const { cacheStorage, claim, context, listeners } = workerListeners();
    cacheStorage.keys.mockResolvedValue([
      "unrelated-cache",
      "srtl-static-oldest",
      "srtl-static-previous",
      "srtl-static-__SRTL_BUILD_REVISION__"
    ]);
    const source = await fs.readFile(path.join(process.cwd(), "public", "service-worker.js"), "utf8");
    new vm.Script(source).runInContext(context);
    const waitUntil = vi.fn();
    listeners.get("activate")?.({ waitUntil });
    const activation = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await activation;

    expect(cacheStorage.delete).toHaveBeenCalledTimes(1);
    expect(cacheStorage.delete).toHaveBeenCalledWith("srtl-static-oldest");
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("removes an incomplete revision cache when precaching fails", async () => {
    const { cacheStorage, context, listeners } = workerListeners();
    const error = new Error("precache failed");
    cacheStorage.open.mockResolvedValue({ addAll: vi.fn().mockRejectedValue(error), match: vi.fn(), put: vi.fn() });
    const source = await fs.readFile(path.join(process.cwd(), "public", "service-worker.js"), "utf8");
    new vm.Script(source).runInContext(context);
    const waitUntil = vi.fn();
    listeners.get("install")?.({ waitUntil });

    await expect(waitUntil.mock.calls[0]?.[0] as Promise<unknown>).rejects.toBe(error);
    expect(cacheStorage.delete).toHaveBeenCalledWith("srtl-static-__SRTL_BUILD_REVISION__");
  });

  it("serves an old hashed asset from the retained cache after another tab activates an update", async () => {
    const { cacheStorage, context, listeners } = workerListeners();
    const retainedResponse = { source: "previous-cache" };
    const currentMatch = vi.fn().mockResolvedValue(undefined);
    const previousMatch = vi.fn().mockResolvedValue(retainedResponse);
    cacheStorage.keys.mockResolvedValue(["srtl-static-previous", "srtl-static-__SRTL_BUILD_REVISION__"]);
    cacheStorage.open.mockImplementation(async (name: string) => ({
      addAll: vi.fn(),
      match: name === "srtl-static-previous" ? previousMatch : currentMatch,
      put: vi.fn()
    }));
    const source = await fs.readFile(path.join(process.cwd(), "public", "service-worker.js"), "utf8");
    new vm.Script(source).runInContext(context);
    const respondWith = vi.fn();
    listeners.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: "https://srtl.test/assets/old-lazy-route.js" },
      respondWith
    });

    expect(respondWith).toHaveBeenCalledTimes(1);
    await expect(respondWith.mock.calls[0]?.[0] as Promise<unknown>).resolves.toBe(retainedResponse);
    expect(previousMatch).toHaveBeenCalledTimes(1);
  });

  it("registers only when enabled in a secure context and emits a passive update event", async () => {
    const installingWorker = Object.assign(new EventTarget(), {
      scriptURL: "https://srtl.test/service-worker.js",
      state: "installing",
      postMessage: vi.fn()
    });
    const registration = Object.assign(new EventTarget(), {
      active: null,
      installing: installingWorker,
      waiting: null,
      unregister: vi.fn()
    });
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: {},
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn()
    });
    const dispatchEvent = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("window", { isSecureContext: true, dispatchEvent });
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    });

    await expect(registerPwaServiceWorker({ enabled: true })).resolves.toBe(registration);
    expect(serviceWorker.register).toHaveBeenCalledWith("/service-worker.js", { scope: "/", updateViaCache: "none" });
    expect(dispatchEvent).not.toHaveBeenCalled();

    registration.dispatchEvent(new Event("updatefound"));
    Object.assign(installingWorker, { state: "installed" });
    Object.assign(registration, { waiting: installingWorker });
    installingWorker.dispatchEvent(new Event("statechange"));

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0]?.[0] as CustomEvent).type).toBe(pwaUpdateReadyEvent);
    expect(getPendingPwaUpdate()).toBe(registration);
    expect(installingWorker.postMessage).not.toHaveBeenCalled();
  });

  it("removes only this app's worker and caches when registration is disabled", async () => {
    const activeWorker = Object.assign(new EventTarget(), { scriptURL: "https://srtl.test/service-worker.js" });
    const unregister = vi.fn().mockResolvedValue(true);
    const registration = Object.assign(new EventTarget(), {
      active: activeWorker,
      installing: null,
      waiting: null,
      unregister
    });
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: activeWorker,
      register: vi.fn(),
      getRegistration: vi.fn().mockResolvedValue(registration)
    });
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", { serviceWorker });
    vi.stubGlobal("window", { isSecureContext: true, dispatchEvent: vi.fn() });
    vi.stubGlobal("caches", {
      keys: vi.fn().mockResolvedValue(["srtl-static-v1", "another-app-cache"]),
      delete: deleteCache
    });

    await expect(registerPwaServiceWorker({ enabled: false })).resolves.toBeNull();
    expect(serviceWorker.register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledWith("srtl-static-v1");
  });

  it("requires an explicit activation call and reports registration failures", async () => {
    const postMessage = vi.fn();
    const waitingWorker = Object.assign(new EventTarget(), { postMessage });
    const registration = Object.assign(new EventTarget(), { waiting: waitingWorker });
    activatePwaUpdate(registration);
    expect(postMessage).toHaveBeenCalledWith({ type: "SRTL_ACTIVATE_UPDATE" });
    clearPendingPwaUpdate();

    const dispatchEvent = vi.fn();
    const error = new Error("registration failed");
    vi.stubGlobal("navigator", { serviceWorker: { register: vi.fn().mockRejectedValue(error) } });
    vi.stubGlobal("window", { isSecureContext: true, dispatchEvent });
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, init: CustomEventInit<T>) {
        super(type);
        this.detail = init.detail as T;
      }
    });

    await expect(registerPwaServiceWorker({ enabled: true })).resolves.toBeNull();
    expect((dispatchEvent.mock.calls[0]?.[0] as CustomEvent).type).toBe(pwaRegistrationErrorEvent);
  });
});
