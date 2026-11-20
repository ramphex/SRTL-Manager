// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrphanLeftoverFolder, OrphanReview, OrphanReviewItem } from "../src/shared/types";

const api = vi.hoisted(() => ({
  orphanReview: vi.fn(),
  heldOrphans: vi.fn(async () => []),
  jobs: vi.fn(async () => []),
  job: vi.fn(),
  purgeOrphans: vi.fn(async () => ({ jobId: 41 })),
  restoreHeldOrphans: vi.fn(),
  previewReRequests: vi.fn(async () => ({ items: [] })),
  reRequests: vi.fn(async () => ({ items: [], counts: {}, perMinute: 6 }))
}));

vi.mock("../src/client/api", () => ({ api }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("../src/client/App", () => ({
  Panel: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  InfoTooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>
}));

const { OrphanReviewPanel } = await import("../src/client/orphanReview");

const now = Date.now();
const hours = (count: number) => now - count * 3_600_000;

function item(id: number, name: string, patch: Partial<OrphanReviewItem> = {}): OrphanReviewItem {
  return {
    storageFileId: id, rootType: "local", relativePath: `movies/${name}/${name}.mkv`, filePath: `/local/movies/${name}/${name}.mkv`, section: "movies", itemName: name,
    sizeBytes: 1_000, mtimeMs: hours(72), category: "unlinked", protectedReason: null, protectedKind: null, hollow: false, integrity: "ok", zeroSamples: null, label: "no_title_match",
    matchedTitle: null, releaseName: name, releaseStatus: "none_linked", releaseFileCount: 1, releaseLinkedCount: 0, linkedSizeBytes: null, sizeComparison: null, episodeCoverage: null, extraLinkPath: null,
    ...patch
  };
}

function folder(id: number, name: string, patch: Partial<OrphanLeftoverFolder> = {}): OrphanLeftoverFolder {
  return { folderId: id, rootType: "local", relativePath: `movies/${name}`, dirPath: `/local/movies/${name}`, fileCount: 1, totalBytes: 10, newestMtimeMs: hours(72), protectedReason: null, protectedKind: null, ...patch };
}

const recent = { protectedReason: "Modified in the last 24 hours", protectedKind: "recent" as const };

function review(): OrphanReview {
  return {
    rootType: "local",
    items: [
      item(1, "Old One"),
      item(2, "Fresh One", { ...recent, mtimeMs: hours(3) }),
      item(3, "Copying One", { protectedReason: "Part of an unfinished copy", protectedKind: "copy", mtimeMs: hours(1) }),
      item(4, "Old Two", { category: "superseded", label: "superseded" })
    ],
    leftoverFolders: [folder(10, "Old Folder"), folder(11, "Fresh Folder", { ...recent, newestMtimeMs: hours(5) }), folder(12, "Copying Folder", { protectedReason: "Part of an unfinished copy", protectedKind: "copy" })],
    summary: [], labelSummary: [], hollowCount: 0, damagedCount: 0, symlinkInventoryAt: null, storageInventoryAt: null, staleWarning: null, storageStaleWarning: null,
    extraSymlinks: { folders: [], linkCount: 0, unmatchedCount: 0, problems: [] },
    skippedInUse: { total: 0, files: 0, folders: 0, byReason: { library_link: 0, extra_link: 0 } },
    holdDays: 7
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function waitFor(check: () => void, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
}

const text = () => container.textContent ?? "";
const fileRows = () => [...container.querySelectorAll('table[aria-label="Orphan files"] tbody tr .orv-name')].map((cell) => cell.textContent);
const folderRows = () => [...container.querySelectorAll('table[aria-label="Folders with no video"] tbody tr .orv-name')].map((cell) => cell.textContent);
const recentSwitch = () => container.querySelector<HTMLInputElement>('.orv-recent-toggle input[role="switch"]')!;
const selectAll = () => container.querySelector<HTMLInputElement>(".orv-table-bar .orv-select-all input")!;
const tabButton = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim().startsWith(label)) ?? null;
const labelTab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".orv-label-tab")].find((entry) => entry.textContent?.trim().startsWith(label)) ?? null;

async function click(target: HTMLElement | null) {
  expect(target).not.toBeNull();
  await act(async () => {
    target!.click();
  });
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OrphanReviewPanel rootType="local" rootLabel="Local" />
      </QueryClientProvider>
    );
  });
  await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
}

describe("Including recent orphans", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.orphanReview.mockReset();
    api.orphanReview.mockImplementation(async () => review());
    api.purgeOrphans.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("starts off, listing only files with no protection", async () => {
    await render();
    expect(recentSwitch().checked).toBe(false);
    expect(fileRows()).toEqual(["Old One.mkv", "Old Two.mkv"]);
    expect(text()).toContain("2 protected");
    expect(text()).toContain("Include files modified in the last 24 hours (2)");
    expect(labelTab("All")?.textContent).toBe("All 2");
  });

  it("lists, marks, counts and selects recent files when switched on, but never copy-protected ones", async () => {
    await render();
    await click(recentSwitch());
    expect(recentSwitch().checked).toBe(true);
    expect(fileRows()).toEqual(["Old One.mkv", "Fresh One.mkv", "Old Two.mkv"]);
    expect(text()).toContain("Modified 3h ago");
    expect(text()).toContain("1 protected");
    expect(labelTab("All")?.textContent).toBe("All 3");
    expect(labelTab("No title match")?.textContent).toContain("2");
    expect(text()).not.toContain("Copying One");

    await click(selectAll());
    expect(text()).toContain("3 files selected");
    await click([...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes("Purge selected")) ?? null);
    expect(container.querySelector(".orv-confirm-question")?.textContent).toContain("1 was modified in the last 24 hours");
    await click(container.querySelector<HTMLButtonElement>(".orv-confirm-actions button"));
    await waitFor(() => expect(api.purgeOrphans).toHaveBeenCalledTimes(1));
    expect(api.purgeOrphans).toHaveBeenCalledWith(expect.objectContaining({ storageFileIds: [1, 2, 4], folderIds: [], includeRecent: true }));
  });

  it("drops recent files from the selection when switched back off", async () => {
    await render();
    await click(recentSwitch());
    await click(selectAll());
    await click(recentSwitch());
    expect(fileRows()).toEqual(["Old One.mkv", "Old Two.mkv"]);
    expect(text()).toContain("2 files selected");
    await click([...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes("Purge selected")) ?? null);
    expect(container.querySelector(".orv-confirm-question")?.textContent).not.toContain("modified in the last 24 hours");
    await click(container.querySelector<HTMLButtonElement>(".orv-confirm-actions button"));
    await waitFor(() => expect(api.purgeOrphans).toHaveBeenCalledTimes(1));
    expect(api.purgeOrphans).toHaveBeenCalledWith(expect.objectContaining({ storageFileIds: [1, 4], includeRecent: false }));
  });

  it("lists recent folders with a marker when switched on", async () => {
    await render();
    await click(tabButton("Folders with no video"));
    expect(folderRows()).toEqual(["Old Folder"]);
    await click(recentSwitch());
    expect(folderRows()).toEqual(["Old Folder", "Fresh Folder"]);
    expect(text()).toContain("Modified 5h ago");
    expect(text()).not.toContain("Copying Folder");
  });

  it("plans recent files into Purge all eligible and says how many", async () => {
    await render();
    await click(recentSwitch());
    await click(tabButton("Purge all eligible"));
    const summary = document.body.querySelector('[data-testid="purge-all-summary"]');
    expect(summary?.textContent).toContain("3 items");
    expect(document.body.querySelector('[data-testid="purge-all-recent"]')?.textContent).toContain("1 was modified in the last 24 hours");
    const start = [...document.body.querySelectorAll<HTMLButtonElement>(".orphan-toolbar button")].find((entry) => entry.textContent?.includes("Hold 3 items")) ?? null;
    await click(start);
    await waitFor(() => expect(api.purgeOrphans).toHaveBeenCalledTimes(1));
    expect(api.purgeOrphans).toHaveBeenCalledWith(expect.objectContaining({ storageFileIds: [1, 2, 4], includeRecent: true }));
  });
});
