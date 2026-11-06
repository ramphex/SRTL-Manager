import { describe, expect, it } from "vitest";
import { groupAdjacentJobs } from "../src/client/jobGrouping";
import type { JobRecord, JobStatus, JobType } from "../src/shared/types";

function rescan(id: number, itemName: string, status: JobStatus = "completed", extra: Partial<JobRecord> = {}, type: JobType = "scan", minutes = id): JobRecord {
  return {
    id,
    type,
    status,
    createdAt: new Date(Date.UTC(2026, 10, 2, 12, 0, 0) + minutes * 60_000).toISOString(),
    startedAt: null,
    finishedAt: status === "queued" || status === "running" ? null : "2026-11-02T13:00:00.000Z",
    options: { scanSymlinks: true, titleScopes: [{ section: "movies", itemName }] },
    progress: {},
    ...extra
  };
}

// The list is newest first, like the dashboard.
const kinds = (jobs: JobRecord[]) => groupAdjacentJobs(jobs).map((entry) => (entry.kind === "group" ? `g${entry.jobs.length}` : `j${entry.job.id}`));

describe("groupAdjacentJobs", () => {
  it("groups adjacent rescans of the same title, keeping the newest first", () => {
    const entries = groupAdjacentJobs([rescan(3, "Sample Rescan Title"), rescan(2, "Sample Rescan Title"), rescan(1, "Sample Rescan Title")]);
    expect(entries).toHaveLength(1);
    const [group] = entries;
    expect(group.kind === "group" && group.jobs.map((job) => job.id)).toEqual([3, 2, 1]);
    expect(group.kind === "group" && group.summary.note).toBeNull();
  });

  it("breaks the group when a different title sits in between", () => {
    expect(kinds([rescan(4, "A"), rescan(3, "A"), rescan(2, "B"), rescan(1, "A")])).toEqual(["g2", "j2", "j1"]);
  });

  it("never groups different job types or sections", () => {
    expect(kinds([rescan(2, "A", "completed", { type: "audit", options: undefined, selection: { total: 1, unavailable: 0, omittedTitles: 0, titles: [{ section: "movies", itemName: "A", count: 1 }] } as never }), rescan(1, "A")])).toEqual(["j2", "j1"]);
    expect(kinds([rescan(2, "A", "completed", { options: { titleScopes: [{ section: "shows", itemName: "A" }] } }), rescan(1, "A")])).toEqual(["j2", "j1"]);
  });

  it("keeps running and queued jobs visible and ungrouped", () => {
    expect(kinds([rescan(4, "A", "running"), rescan(3, "A", "queued"), rescan(2, "A"), rescan(1, "A")])).toEqual(["j4", "j3", "g2"]);
  });

  it("surfaces failures in the summary", () => {
    const [group] = groupAdjacentJobs([rescan(3, "A"), rescan(2, "A", "failed"), rescan(1, "A", "partially_failed")]);
    expect(group.kind === "group" && group.summary).toMatchObject({ total: 3, failed: 2, note: "2 failed" });
    const [mixed] = groupAdjacentJobs([rescan(2, "A"), rescan(1, "A", "cancelled")]);
    expect(mixed.kind === "group" && mixed.summary.note).toBe("1 cancelled");
  });

  it("never groups multi-title or section-wide jobs", () => {
    const multi = (id: number) => rescan(id, "A", "completed", { options: { titleScopes: [{ section: "movies", itemName: "A" }, { section: "movies", itemName: "B" }] } });
    const whole = (id: number) => rescan(id, "A", "completed", { options: { scanSymlinks: true, symlinkSections: ["movies"] } });
    expect(kinds([multi(4), multi(3), whole(2), whole(1)])).toEqual(["j4", "j3", "j2", "j1"]);
  });

  it("does not group jobs created further apart than the window", () => {
    expect(kinds([rescan(2, "A", "completed", {}, "scan", 100), rescan(1, "A", "completed", {}, "scan", 10)])).toEqual(["j2", "j1"]);
  });
});
