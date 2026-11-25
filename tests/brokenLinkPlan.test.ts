import { describe, expect, it } from "vitest";
import { brokenLinkSections, brokenLinkTitleCount, filterBrokenLinks, groupBrokenLinks } from "../src/client/brokenLinkPlan";
import type { BrokenLinkItem } from "../src/shared/types";

function link(id: number, section: string, itemName: string, fileName: string): BrokenLinkItem {
  return {
    mediaLinkId: id,
    section,
    sectionTitle: section === "shows" ? "TV" : "Films",
    itemName,
    relativePath: `${itemName}/${fileName}`,
    linkPath: `/links/${section}/${itemName}/${fileName}`,
    targetPath: `/remote/${section}/${itemName}/${fileName}`,
    targetRoot: "remote",
    brokenSince: null,
    lastSeenAt: null
  };
}

const items = [
  link(1, "movies", "Quiet Harbor (2011)", "quiet.harbor.mkv"),
  link(2, "shows", "Lantern Bay", "Season 01/Lantern.Bay.S01E01.mkv"),
  link(3, "shows", "Lantern Bay", "Season 01/Lantern.Bay.S01E02.mkv"),
  link(4, "shows", "Paper Lanterns", "Season 02/Paper.Lanterns.S02E05.mkv")
];

describe("broken link review helpers", () => {
  it("filters by folder and searches titles and paths", () => {
    expect(filterBrokenLinks(items, { section: "shows", search: "" }).map((item) => item.mediaLinkId)).toEqual([2, 3, 4]);
    expect(filterBrokenLinks(items, { section: "all", search: "lantern bay" }).map((item) => item.mediaLinkId)).toEqual([2, 3]);
    expect(filterBrokenLinks(items, { section: "all", search: "S02E05" }).map((item) => item.mediaLinkId)).toEqual([4]);
    expect(filterBrokenLinks(items, { section: "movies", search: "lantern" })).toEqual([]);
  });

  it("groups by folder, then title, in list order", () => {
    const groups = groupBrokenLinks(items);
    expect(groups.map((group) => [group.sectionTitle, group.titles.map((title) => [title.itemName, title.links.length])])).toEqual([
      ["Films", [["Quiet Harbor (2011)", 1]]],
      ["TV", [["Lantern Bay", 2], ["Paper Lanterns", 1]]]
    ]);
    expect(brokenLinkTitleCount(items)).toBe(3);
    expect(brokenLinkSections(items)).toEqual([
      { section: "movies", sectionTitle: "Films", count: 1 },
      { section: "shows", sectionTitle: "TV", count: 3 }
    ]);
  });
});
