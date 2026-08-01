import { eq, inArray, sql } from "drizzle-orm";
import { dbAll, first, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import type {
  SectionContentType,
  StoragePolicyCandidate,
  StoragePolicyBulkResult,
  StoragePolicyCategory,
  StoragePolicyKind,
  StoragePolicyTitle
} from "../../shared/types";
import { inferSectionContentType, normalizeSectionContentType } from "../../shared/sections";

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

type StoragePolicyMediaMetadata = {
  title: string;
  normalizedTitle: string;
  sections: string | null;
  linkCount: number;
  remoteLinkCount: number;
  localLinkCount: number;
  fileCount: number;
  remoteFileCount: number;
  localFileCount: number;
  sectionCount: number;
};

type SectionTypeLookup = Map<string, SectionContentType>;

export interface LocalStoragePolicyBootstrapResult {
  foundLocalTitles: number;
  assignedLocal: number;
  skippedExistingPolicy: number;
}

async function getSectionTypeLookup(db: Db): Promise<SectionTypeLookup> {
  return new Map(
    (await db
      .select()
      .from(schema.sections)
    )
      .map((row) => [row.name, normalizeSectionContentType(row.contentType) ?? inferSectionContentType(row.name)])
  );
}

function serializeStoragePolicyTitle(
  row: typeof schema.storagePolicies.$inferSelect,
  sectionTypes: SectionTypeLookup,
  metadata?: StoragePolicyMediaMetadata
): StoragePolicyTitle {
  const sections = splitCandidateSections(metadata?.sections ?? null);
  const policy = row.policy === "location_1" || row.policy === "location_2" ? row.policy : "unassigned";
  return {
    id: row.id,
    title: metadata?.title ?? row.title,
    normalizedTitle: row.normalizedTitle,
    policy,
    category: categorizeCandidateSections(sections, sectionTypes),
    sections,
    linkCount: Number(metadata?.linkCount ?? 0),
    remoteLinkCount: Number(metadata?.remoteLinkCount ?? 0),
    localLinkCount: Number(metadata?.localLinkCount ?? 0),
    fileCount: Number(metadata?.fileCount ?? 0),
    remoteFileCount: Number(metadata?.remoteFileCount ?? 0),
    localFileCount: Number(metadata?.localFileCount ?? 0),
    sectionCount: Number(metadata?.sectionCount ?? 0),
    source: row.source,
    updatedAt: row.updatedAt
  };
}

function serializeUnassignedTitle(row: StoragePolicyMediaMetadata, sectionTypes: SectionTypeLookup): StoragePolicyTitle {
  const sections = splitCandidateSections(row.sections);
  return {
    id: null,
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    policy: "unassigned",
    category: categorizeCandidateSections(sections, sectionTypes),
    sections,
    linkCount: Number(row.linkCount),
    remoteLinkCount: Number(row.remoteLinkCount),
    localLinkCount: Number(row.localLinkCount),
    fileCount: Number(row.fileCount),
    remoteFileCount: Number(row.remoteFileCount),
    localFileCount: Number(row.localFileCount),
    sectionCount: Number(row.sectionCount),
    source: "scan",
    updatedAt: null
  };
}

function serializeCandidate(
  row: {
    title: string;
    normalizedTitle: string;
    sections: string | null;
    linkCount: number;
    remoteLinkCount: number;
    localLinkCount: number;
    fileCount: number;
    remoteFileCount: number;
    localFileCount: number;
    sectionCount: number;
  },
  sectionTypes: SectionTypeLookup
): StoragePolicyCandidate {
  const sections = splitCandidateSections(row.sections);
  return {
    title: row.title,
    normalizedTitle: row.normalizedTitle,
    category: categorizeCandidateSections(sections, sectionTypes),
    sections,
    linkCount: Number(row.linkCount),
    remoteLinkCount: Number(row.remoteLinkCount),
    localLinkCount: Number(row.localLinkCount),
    fileCount: Number(row.fileCount),
    remoteFileCount: Number(row.remoteFileCount),
    localFileCount: Number(row.localFileCount),
    sectionCount: Number(row.sectionCount)
  };
}

function splitCandidateSections(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((section) => section.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function uniqueStoragePolicyTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  const uniqueTitles: string[] = [];
  for (const title of titles) {
    const cleanedTitle = title.trim();
    const normalizedTitle = normalizeTitle(cleanedTitle);
    if (!normalizedTitle || seen.has(normalizedTitle)) continue;
    seen.add(normalizedTitle);
    uniqueTitles.push(cleanedTitle);
  }
  return uniqueTitles;
}

function fallbackStoragePolicyMetadata(title: string): StoragePolicyMediaMetadata {
  return {
    title,
    normalizedTitle: normalizeTitle(title),
    sections: null,
    linkCount: 0,
    remoteLinkCount: 0,
    localLinkCount: 0,
    fileCount: 0,
    remoteFileCount: 0,
    localFileCount: 0,
    sectionCount: 0
  };
}

function categorizeSection(section: string, sectionTypes: SectionTypeLookup): Exclude<StoragePolicyCategory, "mixed"> {
  const type = sectionTypes.get(section) ?? inferSectionContentType(section);
  return type === "shows" || type === "movies" ? type : "other";
}

function categorizeCandidateSections(sections: string[], sectionTypes: SectionTypeLookup): StoragePolicyCategory {
  const categories = new Set(sections.map((section) => categorizeSection(section, sectionTypes)));
  if (categories.size === 0) return "unmatched";
  if (categories.size === 1) return categories.values().next().value ?? "other";
  return "mixed";
}

async function getAllMediaTitleMetadata(db: Db): Promise<Map<string, StoragePolicyMediaMetadata>> {
  const linkRows = await dbAll<{ itemName: string; section: string; kind: string }>(db, sql`
    select ml.item_name as "itemName", ml.section, ml.kind
    from media_links ml
    where ml.missing_since is null
      and ml.is_media = true
  `);
  const fileRows = await dbAll<{ itemName: string; section: string | null; rootType: string }>(db, sql`
    select sf.item_name as "itemName", sf.section, sf.root_type as "rootType"
    from storage_files sf
    where sf.missing_since is null
      and sf.item_name <> ''
  `);
  const metadata = new Map<
    string,
    {
      title: string;
      sections: Set<string>;
      linkCount: number;
      remoteLinkCount: number;
      localLinkCount: number;
      fileCount: number;
      remoteFileCount: number;
      localFileCount: number;
    }
  >();

  for (const row of linkRows) {
    const key = canonicalTitleKey(row.itemName);
    if (!key) continue;
    const current = metadata.get(key) ?? {
      title: row.itemName,
      sections: new Set<string>(),
      linkCount: 0,
      remoteLinkCount: 0,
      localLinkCount: 0,
      fileCount: 0,
      remoteFileCount: 0,
      localFileCount: 0
    };
    current.sections.add(row.section);
    current.linkCount += 1;
    if (row.kind === "remote") current.remoteLinkCount += 1;
    if (row.kind === "local") current.localLinkCount += 1;
    metadata.set(key, current);
  }

  for (const row of fileRows) {
    const key = canonicalTitleKey(row.itemName);
    if (!key) continue;
    const current = metadata.get(key) ?? {
      title: row.itemName,
      sections: new Set<string>(),
      linkCount: 0,
      remoteLinkCount: 0,
      localLinkCount: 0,
      fileCount: 0,
      remoteFileCount: 0,
      localFileCount: 0
    };
    if (row.section) current.sections.add(row.section);
    current.fileCount += 1;
    if (row.rootType === "remote") current.remoteFileCount += 1;
    if (row.rootType === "local") current.localFileCount += 1;
    metadata.set(key, current);
  }

  return new Map(
    [...metadata.entries()].map(([key, row]) => [
      key,
      {
        title: row.title,
        normalizedTitle: normalizeTitle(row.title),
        sections: [...row.sections].join(","),
        linkCount: row.linkCount,
        remoteLinkCount: row.remoteLinkCount,
        localLinkCount: row.localLinkCount,
        fileCount: row.fileCount,
        remoteFileCount: row.remoteFileCount,
        localFileCount: row.localFileCount,
        sectionCount: row.sections.size
      }
    ])
  );
}

async function getCurrentLocalTitleMap(db: Db): Promise<Map<string, string>> {
  const rows = await dbAll<{ title: string }>(db, sql`
    select ml.item_name as title
    from media_links ml
    where ml.missing_since is null
      and ml.is_media = true
      and ml.kind = 'local'
    order by lower(ml.item_name)
  `);
  const titles = new Map<string, string>();
  for (const row of rows) {
    const titleKey = canonicalTitleKey(row.title);
    if (titleKey && !titles.has(titleKey)) titles.set(titleKey, row.title);
  }
  return titles;
}

async function getStoragePoliciesByCanonicalTitle(db: Db): Promise<Map<string, Array<typeof schema.storagePolicies.$inferSelect>>> {
  const policies = new Map<string, Array<typeof schema.storagePolicies.$inferSelect>>();
  for (const row of await db.select().from(schema.storagePolicies)) {
    const titleKey = canonicalTitleKey(row.normalizedTitle);
    if (!titleKey) continue;
    const rows = policies.get(titleKey) ?? [];
    rows.push(row);
    policies.set(titleKey, rows);
  }
  return policies;
}

async function assignLocalPolicy(
  db: Db,
  title: string,
  source: string,
  timestamp: string,
  existingPolicies: Array<typeof schema.storagePolicies.$inferSelect> | undefined
): Promise<void> {
  if (existingPolicies && existingPolicies.length > 0) {
    for (const policy of existingPolicies) {
      await db
        .update(schema.storagePolicies)
        .set({ title, policy: "location_1", source, updatedAt: timestamp })
        .where(eq(schema.storagePolicies.id, policy.id));
    }
    return;
  }

  const normalizedTitle = normalizeTitle(title);
  await db
    .insert(schema.storagePolicies)
    .values({ title, normalizedTitle, policy: "location_1", source, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: schema.storagePolicies.normalizedTitle,
      set: { title, policy: "location_1", source, updatedAt: timestamp }
    });
}

async function syncStoragePolicyMediaLinksForTitleKeys(
  db: Db,
  titlePolicies: Map<string, StoragePolicyKind>,
  timestamp: string,
  mediaLinkIds?: readonly number[]
): Promise<void> {
  if (titlePolicies.size === 0) return;
  const policies = [...new Set(titlePolicies.values())];
  if (mediaLinkIds !== undefined && policies.length === 1) {
    const uniqueIds = [...new Set(mediaLinkIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      await db
        .update(schema.mediaLinks)
        .set({ storagePolicy: policies[0]!, updatedAt: timestamp })
        .where(inArray(schema.mediaLinks.id, uniqueIds.slice(offset, offset + 500)));
    }
  } else {
    for (const link of await db.select().from(schema.mediaLinks)) {
      const policy = titlePolicies.get(canonicalTitleKey(link.itemName));
      if (!policy || link.storagePolicy === policy) continue;
      await db.update(schema.mediaLinks).set({ storagePolicy: policy, updatedAt: timestamp }).where(eq(schema.mediaLinks.id, link.id));
    }
  }
  for (const file of await db.select().from(schema.storageFiles)) {
    const policy = titlePolicies.get(canonicalTitleKey(file.itemName));
    if (!policy || file.storagePolicy === policy) continue;
    await db.update(schema.storageFiles).set({ storagePolicy: policy, updatedAt: timestamp }).where(eq(schema.storageFiles.id, file.id));
  }
}

export async function bootstrapLocalStoragePolicies(
  db: Db,
  options: { overwriteExisting?: boolean; source?: string } = {}
): Promise<LocalStoragePolicyBootstrapResult> {
  const timestamp = nowIso();
  const overwriteExisting = options.overwriteExisting === true;
  const source = options.source ?? "bootstrap";
  const localTitles = await getCurrentLocalTitleMap(db);
  const existingPolicies = await getStoragePoliciesByCanonicalTitle(db);
  const assignedTitlePolicies = new Map<string, StoragePolicyKind>();
  let assignedLocal = 0;
  let skippedExistingPolicy = 0;

  for (const [titleKey, title] of localTitles.entries()) {
    const existing = existingPolicies.get(titleKey);
    if (existing && existing.length > 0 && !overwriteExisting) {
      skippedExistingPolicy += 1;
      continue;
    }
    await assignLocalPolicy(db, title, source, timestamp, existing);
    assignedTitlePolicies.set(titleKey, "location_1");
    assignedLocal += 1;
  }

  await syncStoragePolicyMediaLinksForTitleKeys(db, assignedTitlePolicies, timestamp);

  return {
    foundLocalTitles: localTitles.size,
    assignedLocal,
    skippedExistingPolicy
  };
}

export async function listStoragePolicyTitles(db: Db, policy?: StoragePolicyKind): Promise<StoragePolicyTitle[]> {
  const rows = await db.select().from(schema.storagePolicies);
  const metadata = await getAllMediaTitleMetadata(db);
  const sectionTypes = await getSectionTypeLookup(db);
  const policyRows = rows
    .filter((row) => !policy || policy === "unassigned" || row.policy === policy)
    .map((row) => serializeStoragePolicyTitle(row, sectionTypes, metadata.get(canonicalTitleKey(row.normalizedTitle))));

  if (policy && policy !== "unassigned") {
    return policyRows.sort((a, b) => a.title.localeCompare(b.title));
  }

  const assignedTitleKeys = new Set(rows.map((row) => canonicalTitleKey(row.normalizedTitle)));
  const unassignedRows = [...metadata.entries()]
    .filter(([titleKey, row]) => !assignedTitleKeys.has(titleKey) && row.linkCount > 0)
    .map(([, row]) => serializeUnassignedTitle(row, sectionTypes));

  const combined = policy === "unassigned" ? unassignedRows : [...policyRows, ...unassignedRows];
  return combined.sort((a, b) => a.title.localeCompare(b.title));
}

export async function listStoragePolicyCandidates(db: Db, query = "", limit = 50): Promise<StoragePolicyCandidate[]> {
  const normalizedQuery = normalizeTitle(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const sectionTypes = await getSectionTypeLookup(db);
  const assignedTitleKeys = new Set((await db.select().from(schema.storagePolicies)).map((row) => canonicalTitleKey(row.normalizedTitle)));
  return [...(await getAllMediaTitleMetadata(db)).values()]
    .filter((row) => {
      const haystack = normalizeTitle([row.title, row.sections ?? ""].join(" "));
      return tokens.every((token) => haystack.includes(token));
    })
    .filter((row) => row.linkCount > 0)
    .filter((row) => !assignedTitleKeys.has(canonicalTitleKey(row.normalizedTitle)))
    .sort((a, b) => {
      const aTitle = normalizeTitle(a.title);
      const bTitle = normalizeTitle(b.title);
      const aRank = aTitle === normalizedQuery ? 0 : aTitle.startsWith(tokens[0]) ? 1 : 2;
      const bRank = bTitle === normalizedQuery ? 0 : bTitle.startsWith(tokens[0]) ? 1 : 2;
      return aRank - bRank || a.title.localeCompare(b.title);
    })
    .slice(0, boundedLimit)
    .map((row) => serializeCandidate(row, sectionTypes));
}

export async function findStoragePolicyCandidateTitles(db: Db, titles: string[]): Promise<{ candidateTitles: string[]; invalidTitles: string[] }> {
  const candidatesByTitleKey = new Map<string, string>();
  for (const row of (await getAllMediaTitleMetadata(db)).values()) {
    const titleKey = canonicalTitleKey(row.title);
    if (row.linkCount > 0 && titleKey && !candidatesByTitleKey.has(titleKey)) candidatesByTitleKey.set(titleKey, row.title);
  }

  const candidateTitles: string[] = [];
  const invalidTitles: string[] = [];
  const seenCandidateTitleKeys = new Set<string>();

  for (const title of uniqueStoragePolicyTitles(titles)) {
    const titleKey = canonicalTitleKey(title);
    const candidateTitle = titleKey ? candidatesByTitleKey.get(titleKey) : null;
    if (!candidateTitle) {
      invalidTitles.push(title);
      continue;
    }

    const candidateTitleKey = canonicalTitleKey(candidateTitle);
    if (candidateTitleKey && !seenCandidateTitleKeys.has(candidateTitleKey)) {
      seenCandidateTitleKeys.add(candidateTitleKey);
      candidateTitles.push(candidateTitle);
    }
  }

  return { candidateTitles, invalidTitles };
}

export async function findStoragePolicyCandidateTitle(db: Db, title: string): Promise<string | null> {
  return (await findStoragePolicyCandidateTitles(db, [title])).candidateTitles[0] ?? null;
}

export async function syncStoragePolicyMediaLinks(db: Db, normalizedTitle: string, policy: StoragePolicyKind): Promise<void> {
  const titleKey = canonicalTitleKey(normalizedTitle);
  const timestamp = nowIso();
  const storagePolicy = policy === "location_1" || policy === "location_2" ? policy : "unassigned";
  for (const link of await db.select().from(schema.mediaLinks)) {
    if (canonicalTitleKey(link.itemName) !== titleKey) continue;
    await db.update(schema.mediaLinks).set({ storagePolicy, updatedAt: timestamp }).where(eq(schema.mediaLinks.id, link.id));
  }
  for (const file of await db.select().from(schema.storageFiles)) {
    if (canonicalTitleKey(file.itemName) !== titleKey) continue;
    await db.update(schema.storageFiles).set({ storagePolicy, updatedAt: timestamp }).where(eq(schema.storageFiles.id, file.id));
  }
}

export async function setStoragePolicyTitles(
  db: Db,
  titles: string[],
  policy: StoragePolicyKind,
  options: { source?: string; mediaLinkIds?: readonly number[] } = {}
): Promise<StoragePolicyBulkResult> {
  const uniqueTitles = uniqueStoragePolicyTitles(titles);
  const timestamp = nowIso();
  const source = options.source ?? "manual";
  const assignments = uniqueTitles.map((title) => ({ title, normalizedTitle: normalizeTitle(title), policy, source, updatedAt: timestamp }));

  if (assignments.length > 0) {
    await db.transaction(async (transaction) => {
      const assignmentByTitleKey = new Map(assignments.map((assignment) => [canonicalTitleKey(assignment.title), assignment]));
      const existingPolicies = await transaction.select().from(schema.storagePolicies);
      const matchingPolicies = existingPolicies.filter((row) => assignmentByTitleKey.has(canonicalTitleKey(row.normalizedTitle)));
      if (policy === "unassigned") {
        if (matchingPolicies.length > 0) {
          await transaction.delete(schema.storagePolicies).where(inArray(schema.storagePolicies.id, matchingPolicies.map((row) => row.id)));
        }
      } else {
        const existingByTitleKey = new Map<string, typeof schema.storagePolicies.$inferSelect>();
        const duplicateIds: number[] = [];
        for (const row of matchingPolicies) {
          const titleKey = canonicalTitleKey(row.normalizedTitle);
          if (existingByTitleKey.has(titleKey)) duplicateIds.push(row.id);
          else existingByTitleKey.set(titleKey, row);
        }
        if (duplicateIds.length > 0) await transaction.delete(schema.storagePolicies).where(inArray(schema.storagePolicies.id, duplicateIds));

        const updates = assignments.flatMap((assignment) => {
          const existing = existingByTitleKey.get(canonicalTitleKey(assignment.title));
          return existing ? [{ id: existing.id, ...assignment }] : [];
        });
        if (updates.length > 0) {
          const updateRows = sql.join(
            updates.map((assignment) => sql`(${assignment.id}::integer, ${assignment.title}::text, ${assignment.normalizedTitle}::text)`),
            sql`, `
          );
          await transaction.execute(sql`
            update storage_policies as stored
            set title = policy_map.title,
                normalized_title = policy_map.normalized_title,
                policy = ${policy},
                source = ${source},
                updated_at = ${timestamp}
            from (values ${updateRows}) as policy_map(id, title, normalized_title)
            where stored.id = policy_map.id
          `);
        }

        const inserts = assignments.filter((assignment) => !existingByTitleKey.has(canonicalTitleKey(assignment.title)));
        if (inserts.length > 0) {
          await transaction
            .insert(schema.storagePolicies)
            .values(inserts.map((assignment) => ({ ...assignment, policy })))
            .onConflictDoUpdate({
              target: schema.storagePolicies.normalizedTitle,
              set: { title: sql`excluded.title`, policy, source, updatedAt: timestamp }
            });
        }
      }

      const titlePolicies = new Map(assignments.map((assignment) => [canonicalTitleKey(assignment.title), policy]));
      await syncStoragePolicyMediaLinksForTitleKeys(transaction, titlePolicies, timestamp, options.mediaLinkIds);
    });
  }

  const sectionTypes = await getSectionTypeLookup(db);
  const metadata = await getAllMediaTitleMetadata(db);
  const storagePolicyRows = new Map((await db.select().from(schema.storagePolicies)).map((row) => [canonicalTitleKey(row.normalizedTitle), row]));
  const items = uniqueTitles.map((title) => {
    const titleKey = canonicalTitleKey(title);
    const rowMetadata = metadata.get(titleKey) ?? fallbackStoragePolicyMetadata(title);
    if (policy === "unassigned") return serializeUnassignedTitle(rowMetadata, sectionTypes);
    const row = storagePolicyRows.get(titleKey);
    if (!row) throw new Error("Storage policy was not saved");
    return serializeStoragePolicyTitle(row, sectionTypes, rowMetadata);
  });

  return { updated: items.length, policy, items };
}

export async function setStoragePolicyTitle(
  db: Db,
  title: string,
  policy: StoragePolicyKind,
  options: { source?: string; mediaLinkIds?: readonly number[] } = {}
): Promise<StoragePolicyTitle> {
  return (await setStoragePolicyTitles(db, [title], policy, options)).items[0] ?? {
    id: null,
    title,
    normalizedTitle: normalizeTitle(title),
    policy: "unassigned",
    category: "unmatched",
    sections: [],
    linkCount: 0,
    remoteLinkCount: 0,
    localLinkCount: 0,
    fileCount: 0,
    remoteFileCount: 0,
    localFileCount: 0,
    sectionCount: 0,
    source: "scan",
    updatedAt: null
  };
}

export async function removeStoragePolicyTitle(db: Db, id: number): Promise<StoragePolicyTitle | null> {
  const existing = await first(db.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.id, id)).limit(1));
  if (!existing) return null;
  const metadata = (await getAllMediaTitleMetadata(db)).get(canonicalTitleKey(existing.normalizedTitle));

  await db.delete(schema.storagePolicies).where(eq(schema.storagePolicies.id, id));
  await syncStoragePolicyMediaLinks(db, existing.normalizedTitle, "unassigned");

  return serializeStoragePolicyTitle(existing, await getSectionTypeLookup(db), metadata);
}
