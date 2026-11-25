import { createSearchMatcher } from "../shared/search";
import type { BrokenLinkItem } from "../shared/types";

export interface BrokenLinkFilters {
  section: string | "all";
  search: string;
}

/** Links matching the folder and the search, searched by title, link path and target path, in list order. */
export function filterBrokenLinks(items: BrokenLinkItem[], filters: BrokenLinkFilters): BrokenLinkItem[] {
  const matchesSearch = createSearchMatcher(filters.search);
  return items.filter((item) => {
    if (filters.section !== "all" && item.section !== filters.section) return false;
    return !matchesSearch || matchesSearch(item.itemName, item.relativePath, item.targetPath);
  });
}

export interface BrokenLinkTitleGroup {
  key: string;
  itemName: string;
  links: BrokenLinkItem[];
}

export interface BrokenLinkSectionGroup {
  section: string;
  sectionTitle: string;
  titles: BrokenLinkTitleGroup[];
}

/** Groups links by folder, then title, keeping the order they came in. */
export function groupBrokenLinks(items: BrokenLinkItem[]): BrokenLinkSectionGroup[] {
  const sections = new Map<string, BrokenLinkSectionGroup>();
  const titles = new Map<string, BrokenLinkTitleGroup>();
  for (const item of items) {
    let section = sections.get(item.section);
    if (!section) {
      section = { section: item.section, sectionTitle: item.sectionTitle, titles: [] };
      sections.set(item.section, section);
    }
    const key = `${item.section}\0${item.itemName}`;
    let title = titles.get(key);
    if (!title) {
      title = { key, itemName: item.itemName, links: [] };
      titles.set(key, title);
      section.titles.push(title);
    }
    title.links.push(item);
  }
  return [...sections.values()];
}

/** How many distinct titles the links belong to. */
export function brokenLinkTitleCount(items: Array<Pick<BrokenLinkItem, "section" | "itemName">>): number {
  return new Set(items.map((item) => `${item.section}\0${item.itemName}`)).size;
}

/** The library folders that hold broken links, with how many each has, in list order. */
export function brokenLinkSections(items: BrokenLinkItem[]): Array<{ section: string; sectionTitle: string; count: number }> {
  const sections = new Map<string, { section: string; sectionTitle: string; count: number }>();
  for (const item of items) {
    const entry = sections.get(item.section);
    if (entry) entry.count += 1;
    else sections.set(item.section, { section: item.section, sectionTitle: item.sectionTitle, count: 1 });
  }
  return [...sections.values()];
}
