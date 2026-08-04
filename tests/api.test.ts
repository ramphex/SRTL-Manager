import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaLinksByIds } from "../src/client/api";
import type { MediaLinkRow } from "../src/shared/types";

function mediaLink(id: number): MediaLinkRow {
  const timestamp = "2026-08-01T08:00:00.000Z";
  return {
    id,
    section: "shows",
    itemName: `Selected Title ${id}`,
    relativePath: `Selected Title ${id}/episode.mkv`,
    linkPath: `/links/Selected Title ${id}/episode.mkv`,
    targetPath: `/remote/Selected Title ${id}/episode.mkv`,
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "location_1",
    resolvedStorageFileId: null,
    sizeBytes: null,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lastChangedAt: timestamp,
    missingSince: null,
    updatedAt: timestamp
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media link lookup", () => {
  it("splits more than 1,000 selected IDs into bounded requests and preserves order", async () => {
    const requestIds: number[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        const ids = (JSON.parse(String(init?.body)) as { ids: number[] }).ids;
        requestIds.push(ids);
        return new Response(JSON.stringify(ids.map(mediaLink)), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const ids = Array.from({ length: 1176 }, (_, index) => index + 1);
    const rows = await mediaLinksByIds(ids);

    expect(requestIds.map((batch) => batch.length)).toEqual([1000, 176]);
    expect(rows.map((row) => row.id)).toEqual(ids);
  });

  it("deduplicates IDs before batching", async () => {
    const requestIds: number[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        const ids = (JSON.parse(String(init?.body)) as { ids: number[] }).ids;
        requestIds.push(ids);
        return new Response(JSON.stringify(ids.map(mediaLink)), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const rows = await mediaLinksByIds([2, 1, 2, 3, 1]);

    expect(requestIds).toEqual([[2, 1, 3]]);
    expect(rows.map((row) => row.id)).toEqual([2, 1, 3]);
  });
});
