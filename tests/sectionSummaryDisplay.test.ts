import { describe, expect, it } from "vitest";
import { inventoryCopyToLocalCount, inventoryCopyToRemoteCount } from "../src/client/appShared";
import { inventoryPolicyNeededCount, mediaLinkTreeStatusCounts, orderSectionSummaries, sectionActionUnit, sectionCompositionParts } from "../src/client/sectionSummaryDisplay";
import type { SectionSummary } from "../src/shared/types";

function sectionSummary(section: string): SectionSummary {
  return {
    section,
    title: section,
    type: "other",
    totalLinks: 0,
    itemCount: 0,
    seasonCount: 0,
    episodeCount: 0,
    remoteLinks: 0,
    localLinks: 0,
    brokenLinks: 0,
    otherLinks: 0,
    nonMediaLinks: 0,
    actionableRemoteLinks: 0,
    actionableLocalLinks: 0,
    assignedRemoteLinks: 0,
    unassignedRemoteLinks: 0,
    unassignedLocalLinks: 0
  };
}

describe("section summary display helpers", () => {
  it("does not present unlinked storage files as copyable library work", () => {
    const summary = { actionableRemoteLinks: 195, actionableRemoteFiles: 54, actionableLocalLinks: 7, actionableLocalFiles: 3 };
    expect(inventoryCopyToLocalCount(summary)).toBe(195);
    expect(inventoryCopyToRemoteCount(summary)).toBe(7);
  });

  it("uses episode units for show section action counts", () => {
    expect(sectionActionUnit({ section: "shows", type: "shows" }, 92)).toBe("episodes");
    expect(sectionActionUnit({ section: "anime", type: "shows" }, 1)).toBe("episode");
  });

  it("uses movie units for movie section action counts", () => {
    expect(sectionActionUnit({ section: "movies", type: "movies" }, 10)).toBe("movies");
    expect(sectionActionUnit({ section: "movies4k", type: "movies" }, 1)).toBe("movie");
  });

  it("summarizes show composition as titles, seasons, and episodes", () => {
    expect(sectionCompositionParts({ section: "shows", type: "shows", itemCount: 12, seasonCount: 25, episodeCount: 92 })).toEqual([
      { value: 12, unit: "shows" },
      { value: 25, unit: "seasons" },
      { value: 92, unit: "episodes" }
    ]);
  });

  it("summarizes movie composition as movie titles", () => {
    expect(sectionCompositionParts({ section: "movies", type: "movies", itemCount: 10, seasonCount: 0, episodeCount: 10 })).toEqual([{ value: 10, unit: "movies" }]);
  });

  it("orders section summaries by saved library section order", () => {
    const sections = [sectionSummary("alpha"), sectionSummary("beta"), sectionSummary("gamma")];

    expect(orderSectionSummaries(sections, ["gamma", "alpha", "beta"]).map((section) => section.section)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("keeps unconfigured section summaries after configured sections in their original order", () => {
    const sections = [sectionSummary("alpha"), sectionSummary("beta"), sectionSummary("gamma"), sectionSummary("delta")];

    expect(orderSectionSummaries(sections, ["gamma", "alpha"]).map((section) => section.section)).toEqual(["gamma", "alpha", "beta", "delta"]);
  });

  it("counts policy-needed work from symlinks only", () => {
    const summary = {
      unassignedRemoteLinks: 92,
      unassignedLocalLinks: 11,
      unassignedRemoteFiles: 7683,
      unassignedLocalFiles: 15
    };
    expect(inventoryPolicyNeededCount(summary)).toBe(103);
  });

  it("does not duplicate kept-remote symlinks as generic remote status", () => {
    expect(
      mediaLinkTreeStatusCounts({
        remoteLinks: 26,
        localLinks: 0,
        brokenLinks: 0,
        otherLinks: 0,
        nonMediaLinks: 0,
        actionableRemoteLinks: 0,
        actionableLocalLinks: 0,
        assignedRemoteLinks: 26,
        unassignedRemoteLinks: 0,
        unassignedLocalLinks: 0
      })
    ).toEqual([{ label: "Location 2", count: 26 }]);
  });

  it("keeps settled local symlinks as local status", () => {
    expect(
      mediaLinkTreeStatusCounts({
        remoteLinks: 0,
        localLinks: 8,
        brokenLinks: 0,
        otherLinks: 0,
        nonMediaLinks: 0,
        actionableRemoteLinks: 0,
        actionableLocalLinks: 0,
        assignedRemoteLinks: 0,
        unassignedRemoteLinks: 0,
        unassignedLocalLinks: 0
      })
    ).toEqual([{ label: "Local", count: 8 }]);
  });

  it("shows action buckets instead of duplicating raw location counts", () => {
    expect(
      mediaLinkTreeStatusCounts({
        remoteLinks: 9,
        localLinks: 6,
        brokenLinks: 1,
        otherLinks: 0,
        nonMediaLinks: 0,
        actionableRemoteLinks: 2,
        actionableLocalLinks: 3,
        assignedRemoteLinks: 4,
        unassignedRemoteLinks: 1,
        unassignedLocalLinks: 2
      })
    ).toEqual([
      { label: "Unassigned", count: 3, kind: "policy_needed" },
      { label: "Copy To Local", count: 2, kind: "copy_to_local" },
      { label: "Copy To Remote", count: 3, kind: "copy_to_remote" },
      { label: "broken", count: 1 },
      { label: "Location 2", count: 4 },
      { label: "Local", count: 1 },
      { label: "Remote", count: 2 }
    ]);
  });
});
