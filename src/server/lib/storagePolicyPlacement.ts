// Storage policies belong to a library folder (section) plus a title. A row whose section is empty is "not placed
// yet": its title had no links in any folder when it was saved. The first time the title shows up in folders, the
// row is copied to each of those folders and removed, so it behaves as the title-wide policy it used to be.

export const unplacedSection = "";

export function normalizeTitle(value: string): string {
  return value.trim().toLowerCase();
}

export function canonicalTitleKey(value: string): string {
  return normalizeTitle(value)
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key one folder's copy of a title is stored and matched under. */
export function storagePolicyKey(section: string, title: string): string {
  return `${section}\u0000${canonicalTitleKey(title)}`;
}

export interface PlaceablePolicyRow {
  id: number;
  section: string;
  title: string;
  normalizedTitle: string;
  policy: string;
  source: string;
  updatedAt: string;
}

export interface PolicyPlacement {
  inserts: Array<Omit<PlaceablePolicyRow, "id">>;
  deleteIds: number[];
}

function newestFirst(a: PlaceablePolicyRow, b: PlaceablePolicyRow): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id;
}

/**
 * Plans how unplaced rows become per-folder rows. `linkTitles` are the (section, item name) pairs that have links.
 * An unplaced row is copied to every folder holding its title that has no row of its own yet, then removed.
 * When two unplaced rows match the same title, the most recently updated one wins. Rows with no folder stay.
 */
export function planPolicyPlacement(policies: readonly PlaceablePolicyRow[], linkTitles: Iterable<{ section: string; itemName: string }>): PolicyPlacement {
  const unplaced = policies.filter((row) => row.section === unplacedSection).sort(newestFirst);
  if (unplaced.length === 0) return { inserts: [], deleteIds: [] };
  const sectionsByTitle = new Map<string, Set<string>>();
  for (const { section, itemName } of linkTitles) {
    const titleKey = canonicalTitleKey(itemName);
    if (!titleKey || !section) continue;
    const sections = sectionsByTitle.get(titleKey) ?? new Set<string>();
    sections.add(section);
    sectionsByTitle.set(titleKey, sections);
  }
  const taken = new Set(policies.filter((row) => row.section !== unplacedSection).map((row) => storagePolicyKey(row.section, row.normalizedTitle)));
  const plan: PolicyPlacement = { inserts: [], deleteIds: [] };
  for (const row of unplaced) {
    const sections = sectionsByTitle.get(canonicalTitleKey(row.normalizedTitle));
    if (!sections?.size) continue;
    for (const section of [...sections].sort()) {
      const key = storagePolicyKey(section, row.normalizedTitle);
      if (taken.has(key)) continue;
      taken.add(key);
      plan.inserts.push({ section, title: row.title, normalizedTitle: row.normalizedTitle, policy: row.policy, source: row.source, updatedAt: row.updatedAt });
    }
    plan.deleteIds.push(row.id);
  }
  return plan;
}
