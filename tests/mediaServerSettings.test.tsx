// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaServer, MediaServerList, MediaServerPinStatus } from "../src/shared/mediaServers";

const api = vi.hoisted(() => ({
  list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn(), startPin: vi.fn(), checkPin: vi.fn()
}));
const plexWindow = vi.hoisted(() => ({ show: vi.fn(), close: vi.fn() }));
const openPlexWindow = vi.hoisted(() => vi.fn(() => plexWindow));

vi.mock("../src/client/App", () => ({ InfoTooltip: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../src/client/appShared", () => ({ formatDate: (value: string) => value }));
vi.mock("../src/client/mediaServerApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/mediaServerApi")>();
  return { ...actual, mediaServerApi: api, openPlexWindow };
});

const { pollPlexPin } = await import("../src/client/mediaServerApi");
const { MediaServerSettingsPanel } = await import("../src/client/mediaServerSettings");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("pollPlexPin", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never sends a check while the previous one is still waiting for an answer", async () => {
    const answers = [deferred<MediaServerPinStatus>(), deferred<MediaServerPinStatus>()];
    const check = vi.fn(() => answers[check.mock.calls.length - 1]!.promise);
    const updates: unknown[] = [];
    const stop = pollPlexPin(check, (update) => updates.push(update), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(1);
    // Saving the token and testing the server can take far longer than the poll interval.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(check).toHaveBeenCalledTimes(1);
    answers[0]!.resolve({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(2999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops after a check says the sign-in was approved, so no late check can report an error", async () => {
    const check = vi.fn<() => Promise<MediaServerPinStatus>>()
      .mockResolvedValueOnce({ status: "waiting" })
      .mockResolvedValueOnce({ status: "authorized" })
      .mockRejectedValue(new Error("This Plex sign-in expired or a newer one replaced it."));
    const updates: unknown[] = [];
    pollPlexPin(check, (update) => updates.push(update), 3000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([{ status: { status: "waiting" } }, { status: { status: "authorized" } }]);
  });

  it("stops on an expired sign-in or an error, and ignores an answer that arrives after stop", async () => {
    const expired = vi.fn<() => Promise<MediaServerPinStatus>>().mockResolvedValue({ status: "expired" });
    pollPlexPin(expired, () => undefined, 3000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(expired).toHaveBeenCalledTimes(1);

    const failure = new Error("boom");
    const failing = vi.fn<() => Promise<MediaServerPinStatus>>().mockRejectedValue(failure);
    const failingUpdates: unknown[] = [];
    pollPlexPin(failing, (update) => failingUpdates.push(update), 3000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failingUpdates).toEqual([{ error: failure }]);

    const answer = deferred<MediaServerPinStatus>();
    const slow = vi.fn(() => answer.promise);
    const slowUpdates: unknown[] = [];
    const stop = pollPlexPin(slow, (update) => slowUpdates.push(update), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    stop();
    answer.resolve({ status: "authorized" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(slowUpdates).toEqual([]);
  });
});

function plexServer(overrides: Partial<MediaServer> = {}): MediaServer {
  return { id: "new1", kind: "plex", name: "Home Plex", url: "http://plex:32400", hasToken: false, prefixMappings: [], machineIdentifier: null, accountName: null, version: null, lastCheckedAt: null, lastError: null, ...overrides };
}

describe("Settings > Media servers, adding a Plex server", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.list.mockResolvedValue({ servers: [], limit: 10 } satisfies MediaServerList);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><MediaServerSettingsPanel /></QueryClientProvider>); });
    await settle();
  }
  const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const button = (name: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
  const click = async (element: Element | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => { (element as HTMLElement).click(); });
    await settle();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const menuButton = () => container.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")!;
  const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>("[role='menu'] [role='menuitem']")];
  const addServer = async (kind: string) => {
    await click(menuButton());
    await click(menuItems().find((item) => item.textContent?.trim() === kind));
  };
  const key = async (target: Element, name: string) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  };
  const field = (label: string) => [...container.querySelectorAll("label")].find((entry) => entry.textContent?.startsWith(label))!;
  const inputFor = (label: string) => {
    const element = field(label);
    return (element.htmlFor ? container.querySelector(`#${CSS.escape(element.htmlFor)}`) : element.querySelector("input")) as HTMLInputElement;
  };

  it("adds servers from one Add server menu that works from the keyboard", async () => {
    await render();
    const trigger = menuButton();
    expect(trigger.textContent?.trim()).toBe("Add server");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[role='menu']")).toBeNull();
    await click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(container.querySelector("[role='menu']")!.id);
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(["Plex", "Jellyfin", "Dupelix"]);
    // The icons are decorative, so each item is named by its server type alone.
    expect(menuItems().every((item) => item.querySelector("svg")?.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(document.activeElement).toBe(menuItems()[0]);
    await key(menuItems()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(menuItems()[1]);
    await key(menuItems()[1]!, "End");
    expect(document.activeElement).toBe(menuItems()[2]);
    await key(menuItems()[2]!, "ArrowDown");
    expect(document.activeElement).toBe(menuItems()[0]);
    await key(menuItems()[0]!, "ArrowUp");
    expect(document.activeElement).toBe(menuItems()[2]);
    await key(menuItems()[2]!, "Escape");
    expect(container.querySelector("[role='menu']")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    // ArrowUp on the button opens the menu on its last item; a click outside closes it.
    await key(trigger, "ArrowUp");
    expect(document.activeElement).toBe(menuItems()[2]);
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(container.querySelector("[role='menu']")).toBeNull();

    // Picking a type opens its form, focused on the first field, and the button stays disabled while it is open.
    await addServer("Jellyfin");
    const form = container.querySelector("form[aria-label='Add Jellyfin server']")!;
    expect(form).toBeTruthy();
    expect(document.activeElement).toBe(form.querySelector("input"));
    expect(menuButton().disabled).toBe(true);
    expect(form.querySelector("button[type='submit']")!.textContent?.trim()).toBe("Add Jellyfin server");
    await click(button("Cancel"));
    expect(menuButton().disabled).toBe(false);
  });

  it("disables Add server when the server list is full", async () => {
    api.list.mockResolvedValue({ servers: [plexServer()], limit: 1 } satisfies MediaServerList);
    await render();
    expect(menuButton().disabled).toBe(true);
    expect(container.textContent).toContain("SRTL supports up to 1 media servers.");
  });

  it("leads with Sign in with Plex and starts it as soon as the server is added", async () => {
    await render();
    await addServer("Plex");
    const form = container.querySelector("form[aria-label='Add Plex server']")!;
    expect(form.textContent).toContain("Sign in with Plex to connect automatically. SRTL gets the token from plex.tv for you.");
    // Pasting a token is the secondary path, folded away with where the token comes from and what never to use.
    const manual = form.querySelector("details")!;
    expect(manual.open).toBe(false);
    expect(manual.querySelector("summary")!.textContent).toBe("Or enter a token manually");
    expect(manual.textContent).toContain("View XML");
    expect(manual.textContent).toContain("Never use the PlexOnlineToken");

    await type(inputFor("Name"), "Home Plex");
    await type(inputFor("Server URL"), "http://plex:32400");
    const added: MediaServerList = { servers: [plexServer()], limit: 10 };
    api.add.mockResolvedValue(added);
    api.startPin.mockResolvedValue({ pinId: 77, code: "WXYZ", authUrl: "https://app.plex.invalid/auth#?code=WXYZ", expiresAt: "2026-11-17T01:00:00.000Z" });
    api.checkPin.mockReturnValue(new Promise(() => undefined));
    api.list.mockResolvedValue(added);

    await click(button("Add and sign in with Plex"));
    // The window opens during the click itself, so browsers do not block it, and is pointed at plex.tv once there is a PIN.
    expect(openPlexWindow).toHaveBeenCalledTimes(1);
    expect(api.add).toHaveBeenCalledWith("plex", { name: "Home Plex", url: "http://plex:32400", token: "", prefixMappings: [] });
    expect(api.startPin).toHaveBeenCalledWith("new1");
    expect(plexWindow.show).toHaveBeenCalledWith("https://app.plex.invalid/auth#?code=WXYZ");
    expect(plexWindow.close).not.toHaveBeenCalled();

    expect(container.querySelector("form[aria-label='Add Plex server']")).toBeNull();
    const card = container.querySelector("section[aria-label='Plex server Home Plex']")!;
    expect(card.textContent).toContain("Waiting for plex.tv");
    expect(card.textContent).toContain("code WXYZ");
    expect(card.querySelector(".error")).toBeNull();
  });

  it("adds a server with a pasted token without opening plex.tv", async () => {
    await render();
    await addServer("Plex");
    await type(inputFor("Name"), "Home Plex");
    await type(inputFor("Server URL"), "http://plex:32400");
    await type(inputFor("Plex token"), "pasted-token");
    api.add.mockResolvedValue({ servers: [plexServer({ hasToken: true })], limit: 10 } satisfies MediaServerList);
    await click(button("Add Plex server"));
    expect(api.add).toHaveBeenCalledWith("plex", expect.objectContaining({ token: "pasted-token" }));
    expect(openPlexWindow).not.toHaveBeenCalled();
    expect(api.startPin).not.toHaveBeenCalled();
    const card = container.querySelector("section[aria-label='Plex server Home Plex']")!;
    expect(button("Sign in with Plex again")).toBeTruthy();
    expect(card.textContent).toContain("Reconnects this server through plex.tv");
  });

  it("keeps the new server and says why when the sign-in cannot start", async () => {
    await render();
    await addServer("Plex");
    await type(inputFor("Name"), "Home Plex");
    await type(inputFor("Server URL"), "http://plex:32400");
    api.add.mockResolvedValue({ servers: [plexServer()], limit: 10 } satisfies MediaServerList);
    api.startPin.mockRejectedValue(new Error("plex.tv could not be reached."));
    await click(button("Add and sign in with Plex"));
    expect(plexWindow.close).toHaveBeenCalled();
    const card = container.querySelector("section[aria-label='Plex server Home Plex']")!;
    expect(card.querySelector(".error")!.textContent).toBe("plex.tv could not be reached.");
    expect(button("Sign in with Plex")).toBeTruthy();
  });

  it("shows Signed in, and no error, when a sign-in finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.list.mockResolvedValue({ servers: [plexServer()], limit: 10 } satisfies MediaServerList);
      await render();
      api.startPin.mockResolvedValue({ pinId: 77, code: "WXYZ", authUrl: "https://app.plex.invalid/auth", expiresAt: "2026-11-17T01:00:00.000Z" });
      const signedIn: MediaServerList = { servers: [plexServer({ hasToken: true, accountName: "owner", lastCheckedAt: "2026-11-17T00:51:00.000Z" })], limit: 10 };
      api.checkPin.mockResolvedValueOnce({ status: "authorized", servers: signedIn })
        .mockRejectedValue(new Error("This Plex sign-in expired or a newer one replaced it. Select Sign in with Plex to start again."));
      await click(button("Sign in with Plex"));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await settle();
      expect(api.checkPin).toHaveBeenCalledTimes(1);
      const card = container.querySelector("section[aria-label='Plex server Home Plex']")!;
      expect(card.textContent).toContain("Signed in with Plex.");
      expect(card.querySelector(".watch-sync-signin .error")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a Dupelix server with an API key, naming the scopes the key needs, and never opens plex.tv", async () => {
    await render();
    await addServer("Dupelix");
    const form = container.querySelector("form[aria-label='Add Dupelix server']")!;
    expect(form.textContent).toContain("Needs the activity.read scope.");
    expect(form.textContent).toContain("Use one key per address");
    expect(form.querySelector("details")).toBeNull();
    await type(inputFor("Name"), "Dupelix");
    await type(inputFor("Server URL"), "https://dupelix.example.com");
    await type(inputFor("API key"), "msk_examplekeyexamplekey");
    const added: MediaServerList = { servers: [plexServer({ kind: "dupelix", name: "Dupelix", url: "https://dupelix.example.com", hasToken: true })], limit: 10 };
    api.add.mockResolvedValue(added);
    api.list.mockResolvedValue(added);
    await click(button("Add Dupelix server"));
    expect(api.add).toHaveBeenCalledWith("dupelix", { name: "Dupelix", url: "https://dupelix.example.com", token: "msk_examplekeyexamplekey", prefixMappings: [] });
    expect(openPlexWindow).not.toHaveBeenCalled();
    const card = container.querySelector("section[aria-label='Dupelix server Dupelix']")!;
    expect(card).toBeTruthy();
    expect(card.querySelector(".watch-sync-signin")).toBeNull();
    expect(button("Test connection")).toBeTruthy();
  });

  it("shows a Dupelix key's name, expiry, scopes, and the optional scopes it lacks", async () => {
    api.list.mockResolvedValue({ servers: [plexServer({
      kind: "dupelix", name: "Dupelix", url: "http://dupelix.example.com:8080", hasToken: true, version: "0.1.0 b1 (API revision 148)", lastCheckedAt: "2026-11-26T05:00:00.000Z",
      apiKey: { name: "SRTL Manager", prefix: "msk_ab12cd34", scopes: ["activity.network", "activity.read", "library.read"], expiresAt: null, lanOnly: true }
    })], limit: 10 } satisfies MediaServerList);
    await render();
    const card = container.querySelector("section[aria-label='Dupelix server Dupelix']")!;
    expect(card.textContent).toContain("SRTL Manager · msk_ab12cd34… · LAN only");
    expect(card.textContent).toContain("ExpiresNever");
    expect(card.textContent).toContain("activity.network, activity.read, library.read");
    expect(card.textContent).toContain("Not on this key: activity.stop (the Stop button), activity.guests (guest profiles' streams, and stopping them).");
    expect(card.textContent).not.toContain("Missing scopes");
    expect(card.textContent).not.toContain("activity.network (");
    // A LAN-only key on the plain HTTP address is fine.
    expect(card.textContent).not.toContain("refuses it on an HTTPS address");
  });

  it("warns that a LAN-only Dupelix key fails on an HTTPS address, and lists library.read as optional", async () => {
    api.list.mockResolvedValue({ servers: [plexServer({
      kind: "dupelix", name: "Dupelix", url: "https://dupelix.example.com", hasToken: true, version: "0.1.0 b1 (API revision 148)", lastCheckedAt: "2026-11-26T05:00:00.000Z",
      apiKey: { name: "SRTL Manager", prefix: "msk_ab12cd34", scopes: ["activity.read"], expiresAt: null, lanOnly: true }
    })], limit: 10 } satisfies MediaServerList);
    await render();
    const card = container.querySelector("section[aria-label='Dupelix server Dupelix']")!;
    expect(card.querySelector(".error")?.textContent).toContain("This key is LAN only, so Dupelix refuses it on an HTTPS address.");
    expect(card.textContent).toContain("library.read (artwork for streams that carry none)");
    expect(card.textContent).not.toContain("Missing scopes");
  });

  it("shows no LAN-only warning for a key Dupelix has not marked LAN only, such as one used on a local integration route", async () => {
    for (const lanOnly of [false, null]) {
      api.list.mockResolvedValue({ servers: [plexServer({
        kind: "dupelix", name: "Dupelix", url: "https://dupelix.example.com", hasToken: true, version: "0.1.0 b1 (API revision 149)", lastCheckedAt: "2026-11-26T05:00:00.000Z",
        apiKey: { name: "SRTL Manager", prefix: "msk_ab12cd34", scopes: ["activity.read"], expiresAt: null, lanOnly }
      })], limit: 10 } satisfies MediaServerList);
      await render();
      const card = container.querySelector("section[aria-label='Dupelix server Dupelix']")!;
      expect(card.textContent).not.toContain("LAN only");
    }
  });
});
