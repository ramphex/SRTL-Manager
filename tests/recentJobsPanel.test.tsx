// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobPage, JobRecord, JobType } from "../src/shared/types";

const api = vi.hoisted(() => ({
  jobPage: vi.fn(),
  mediaLinksByIds: vi.fn(async () => []),
  me: vi.fn(async () => ({ user: { id: 1, role: "owner" } })),
  saveUserPreferences: vi.fn()
}));

vi.mock("../src/client/api", () => ({ api }));
vi.mock("../src/client/App", () => ({
  Panel: ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      <div>{actions}</div>
      {children}
    </section>
  ),
  StatusPill: ({ value }: { value: string }) => <span>{value}</span>,
  TerminateJobDialog: () => null,
  JobStatusTerminateAction: () => null,
  LogChipList: () => null,
  ScanProgressPanel: () => null
}));

const { JobsTable, recentJobsSearchDebounceMs } = await import("../src/client/jobPresentation");

function job(id: number, type: JobType): JobRecord {
  return {
    id,
    type,
    status: "completed",
    createdAt: "2026-07-07T00:00:00.000Z",
    startedAt: "2026-07-07T00:01:00.000Z",
    finishedAt: new Date().toISOString(),
    progress: {},
    options: {}
  };
}

// 25 jobs, newest first; every fifth one is an audit so a search has something to find.
const allJobs = Array.from({ length: 25 }, (_, index) => job(25 - index, (25 - index) % 5 === 0 ? "audit" : "scan"));

function serve({ offset = 0, limit = 10, search }: { offset?: number; limit?: number; search?: string }): JobPage {
  const matching = search ? allJobs.filter((entry) => entry.type.includes(search.toLowerCase())) : allJobs;
  const jobs = matching.slice(offset, offset + limit);
  return { jobs, hasMore: offset + limit < matching.length, nextOffset: offset + jobs.length };
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

function shownJobIds(): number[] {
  return [...container.querySelectorAll("tbody tr td:first-child")].map((cell) => Number(cell.textContent?.replace(/\D+/g, "")));
}

function button(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...container.querySelectorAll("button")].find((entry) => entry.textContent === label) ?? null;
}

async function click(target: HTMLElement | null) {
  expect(target).not.toBeNull();
  await act(async () => {
    target!.click();
  });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function searchBox(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[aria-label="Search jobs"]');
}

describe("Recent jobs list", () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.jobPage.mockReset();
    api.jobPage.mockImplementation(async (options: { offset?: number; limit?: number; search?: string }) => serve(options));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <JobsTable sections={[]} />
        </QueryClientProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("shows the newest ten jobs, then ten more per Show more, and hides the button at the end", async () => {
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    expect(shownJobIds()).toEqual(allJobs.slice(0, 10).map((entry) => entry.id));
    expect(api.jobPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 10, search: undefined }));

    await click(button("Show more"));
    await waitFor(() => expect(shownJobIds()).toHaveLength(20));
    expect(api.jobPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 10, limit: 10 }));

    await click(button("Show more"));
    await waitFor(() => expect(shownJobIds()).toHaveLength(25));
    expect(shownJobIds()).toEqual(allJobs.map((entry) => entry.id));
    expect(button("Show more")).toBeNull();
  });

  it("starts folded at ten again when the Dashboard is opened again", async () => {
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    await click(button("Show more"));
    await waitFor(() => expect(shownJobIds()).toHaveLength(20));
    await act(async () => root.render(<QueryClientProvider client={queryClient}><div /></QueryClientProvider>));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <JobsTable sections={[]} />
        </QueryClientProvider>
      );
    });
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    expect(button("Show more")).not.toBeNull();
  });

  it("opens a search from the header, asks the server once typing settles, and pages through the results", async () => {
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    expect(searchBox()).toBeNull();
    await click(button("Search jobs"));
    const input = searchBox()!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    api.jobPage.mockClear();
    await type(input, "a");
    await type(input, "au");
    await type(input, "audit");
    // Nothing goes to the server until the typing pauses.
    expect(api.jobPage).not.toHaveBeenCalled();
    await waitFor(() => expect(shownJobIds()).toEqual([25, 20, 15, 10, 5]), recentJobsSearchDebounceMs + 2000);
    expect(api.jobPage.mock.calls.map(([options]) => (options as { search?: string }).search)).toEqual(["audit"]);
    expect(api.jobPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, limit: 10, search: "audit", completedWithinMinutes: undefined }));
    expect(button("Show more")).toBeNull();
  });

  it("closes the search with Escape or the X, clearing it and showing the recent jobs again", async () => {
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    await click(button("Search jobs"));
    await type(searchBox()!, "audit");
    await waitFor(() => expect(shownJobIds()).toEqual([25, 20, 15, 10, 5]), recentJobsSearchDebounceMs + 2000);

    await act(async () => {
      searchBox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(searchBox()).toBeNull();
    await waitFor(() => expect(shownJobIds()).toEqual(allJobs.slice(0, 10).map((entry) => entry.id)));

    await click(button("Search jobs"));
    expect(searchBox()!.value).toBe("");
    await type(searchBox()!, "audit");
    await waitFor(() => expect(shownJobIds()).toEqual([25, 20, 15, 10, 5]), recentJobsSearchDebounceMs + 2000);
    await click(button("Close search"));
    expect(searchBox()).toBeNull();
    expect(button("Search jobs")).not.toBeNull();
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
  });

  it("says so when nothing matches the search", async () => {
    await waitFor(() => expect(shownJobIds()).toHaveLength(10));
    await click(button("Search jobs"));
    await type(searchBox()!, "nothing-like-this");
    await waitFor(() => expect(container.textContent).toContain("No jobs match “nothing-like-this”."), recentJobsSearchDebounceMs + 2000);
    expect(container.querySelector("table")).toBeNull();
    expect(button("Show more")).toBeNull();
  });
});
