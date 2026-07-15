import { describe, expect, it } from "vitest";
import { defaultRecentJobsCompletedWindowMinutes, normalizeRecentJobsCompletedWindowMinutes, visibleDashboardJobs } from "../src/client/recentJobs";
import type { JobRecord, JobStatus } from "../src/shared/types";

function job(id: number, status: JobStatus, finishedAt: string | null): JobRecord {
  return {
    id,
    type: "scan",
    status,
    createdAt: "2026-07-07T00:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-07-07T00:01:00.000Z",
    finishedAt,
    progress: {}
  };
}

describe("recent dashboard jobs", () => {
  it("keeps queued and running jobs regardless of the completed job window", () => {
    const now = new Date("2026-07-07T12:00:00.000Z");
    expect(
      visibleDashboardJobs(
        [
          job(5, "completed", "2026-07-07T11:30:00.000Z"),
          job(4, "queued", null),
          job(3, "running", null),
          job(2, "completed", "2026-07-06T11:00:00.000Z"),
          job(1, "failed", "2026-07-07T11:45:00.000Z"),
          job(6, "partially_failed", "2026-07-07T11:50:00.000Z")
        ],
        60,
        now
      ).map((entry) => entry.id)
    ).toEqual([4, 3, 6, 5, 1]);
  });

  it("normalizes unsupported windows back to the default", () => {
    expect(normalizeRecentJobsCompletedWindowMinutes(999)).toBe(defaultRecentJobsCompletedWindowMinutes);
    expect(normalizeRecentJobsCompletedWindowMinutes("60")).toBe(defaultRecentJobsCompletedWindowMinutes);
    expect(normalizeRecentJobsCompletedWindowMinutes(60)).toBe(60);
  });
});
