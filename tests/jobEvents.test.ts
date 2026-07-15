import { describe, expect, it } from "vitest";
import { jobEventCountLabel, mergeJobEventPages } from "../src/client/jobEvents";
import type { JobEventPage, JobEventRecord } from "../src/shared/types";

function event(id: number): JobEventRecord {
  return { id, jobId: 12, timestamp: `2026-07-10T00:00:${String(id).padStart(2, "0")}.000Z`, level: "info", message: `Event ${id}`, data: {} };
}

function page(ids: number[], total: number, hasOlder: boolean): JobEventPage {
  return { events: ids.map(event), total, hasOlder };
}

describe("job event timelines", () => {
  it("merges cursor pages chronologically without duplicate events", () => {
    expect(mergeJobEventPages([page([5, 6, 7], 7, true), page([1, 2, 3, 4, 5], 7, false)]).map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("distinguishes complete and partially loaded event counts", () => {
    expect(jobEventCountLabel(34, 34)).toBe("34 events");
    expect(jobEventCountLabel(100, 134)).toBe("100 of 134 events");
    expect(jobEventCountLabel(1, 1)).toBe("1 event");
  });
});
