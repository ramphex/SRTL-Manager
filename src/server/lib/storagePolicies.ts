import { eq, inArray, sql } from "drizzle-orm";
import { dbAll, first, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import type {
  SectionContentType,
  StoragePolicyBulkResult,
  StoragePolicyCandidate,
  StoragePolicyCategory,
  StoragePolicyKind,
  StoragePolicyOtherFolder,
  StoragePolicyTarget,
  StoragePolicyTitle
} from "../../shared/types";
import { inferSectionContentType, normalizeSectionContentType } from "../../shared/sections";
import { reconcileStorageFilePolicies } from "./storageFilePolicies";
import { canonicalTitleKey, normalizeTitle, planPolicyPlacement, storagePolicyKey, unplacedSection } from "./storagePolicyPlacement";

export { canonicalTitleKey, normalizeTitle, storagePolicyKey, unplacedSection } from "./storagePolicyPlacement";

type PolicyRow = typeof schema.storagePolicies.$inferSelect;

// What SRTL knows about one folder's copy of a title from its links and storage files.
type FolderTitleMetadata = {
  section: string;
  title: string;
  normalizedTitle: string;
  linkCount: number;
  remoteLinkCount: number;
  localLinkCount: number;
  fileCount: number;
  remoteFileCount: number;
  localFileCount: number;
};

type SectionTypeLookup = Map<string, SectionContentType>;

export interface LocalStoragePolicyBootstrapResult {
  foundLocalTitles: number;
  assignedLocal: number;
  skippedExistingPolicy: number;
}

export interface StoragePolicyChangeOptions {
  source?: string;
  mediaLinkIds?: readonly number[];
}

function knownPolicy(value: string | null | undefined): StoragePolicyKind {
  return value === "location_1" || value === "location_2" ? value : "unassigned";
}

async function getSectionTypeLookup(db: Db): Promise<SectionTypeLookup> {
  return new Map(
    (await db.select().from(schema.sections)).map((row) => [row.name, normalizeSectionContentType(row.contentType) ?? inferSectionContentType(row.name)])
  );
}

function categorizeSection(section: string | null, sectionTypes: SectionTypeLookup): StoragePolicyCategory {
  if (!section) return "unmatched";
  const type = sectionTypes.get(section) ?? inferSectionContentType(section);
  return type === "shows" || type === "movies" ? type : "other";
}

function emptyMetadata(section: string, title: string): FolderTitleMetadata {
  return { section, title, normalizedTitle: normalizeTitle(title), linkCount: 0, remoteLinkCount: 0, localLinkCount: 0, fileCount: 0, remoteFileCount: 0, localFileCount: 0 };
}

async function getFolderTitleMetadata(db: Db): Promise<Map<string, FolderTitleMetadata>> {
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
      and sf.section <> ''
  `);
  const metadata = new Map<string, FolderTitleMetadata>();
  for (const row of linkRows) {
    if (!canonicalTitleKey(row.itemName)) continue;
    const key = storagePolicyKey(row.section, row.itemName);
    const current = metadata.get(key) ?? emptyMetadata(row.section, row.itemName);
    current.linkCount += 1;
    if (row.kind === "remote") current.remoteLinkCount += 1;
    if (row.kind === "local") current.localLinkCount += 1;
    metadata.set(key, current);
  }
  for (const row of fileRows) {
    if (!row.section || !canonicalTitleKey(row.itemName)) continue;
    const key = storagePolicyKey(row.section, row.itemName);
    const current = metadata.get(key) ?? emptyMetadata(row.section, row.itemName);
    current.fileCount += 1;
    if (row.rootType === "remote") current.remoteFileCount += 1;
    if (row.rootType === "local") current.localFileCount += 1;
    metadata.set(key, current);
  }
  return metadata;
}

// For each folder copy of a title, the other folders whose links share a storage file with it under a different policy.
async function getSharedFileSections(db: Db): Promise<Map<string, string[]>> {
  const rows = await dbAll<{ section: string; itemName: string; otherSection: string }>(db, sql`
    with shared as (
      select resolved_storage_file_id as file_id
      from media_links
      where missing_since is null and resolved_storage_file_id is not null
      group by resolved_storage_file_id
      having count(distinct section) > 1 and count(distinct storage_policy) > 1
    )
    select distinct mine.section, mine.item_name as "itemName", other.section as "otherSection"
    from media_links mine
    join shared on shared.file_id = mine.resolved_storage_file_id
    join media_links other
      on other.resolved_storage_file_id = mine.resolved_storage_file_id
     and other.missing_since is null
     and other.section <> mine.section
     and other.storage_policy <> mine.storage_policy
    where mine.missing_since is null
  `);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const key = storagePolicyKey(row.section, row.itemName);
    const sections = result.get(key) ?? [];
    if (!sections.includes(row.otherSection)) sections.push(row.otherSection);
    result.set(key, sections.sort((a, b) => a.localeCompare(b)));
  }
  return result;
}

// Policy rows by folder key, newest first when two rows spell the same title differently.
function policyRowsByKey(rows: readonly PolicyRow[]): Map<string, PolicyRow> {
  const result = new Map<string, PolicyRow>();
  for (const row of [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)) {
    const key = storagePolicyKey(row.section, row.normalizedTitle);
    if (!result.has(key)) result.set(key, row);
  }
  return result;
}

interface ListingContext {
  sectionTypes: SectionTypeLookup;
  metadata: Map<string, FolderTitleMetadata>;
  policies: Map<string, PolicyRow>;
  sharedFiles: Map<string, string[]>;
  // Folders holding each title, by canonical title key.
  foldersByTitle: Map<string, string[]>;
}

async function getListingContext(db: Db): Promise<ListingContext> {
  const metadata = await getFolderTitleMetadata(db);
  const foldersByTitle = new Map<string, string[]>();
  for (const row of metadata.values()) {
    if (row.linkCount === 0) continue;
    const titleKey = canonicalTitleKey(row.title);
    foldersByTitle.set(titleKey, [...(foldersByTitle.get(titleKey) ?? []), row.section].sort((a, b) => a.localeCompare(b)));
  }
  return {
    sectionTypes: await getSectionTypeLookup(db),
    metadata,
    policies: policyRowsByKey(await db.select().from(schema.storagePolicies)),
    sharedFiles: await getSharedFileSections(db),
    foldersByTitle
  };
}

function otherFolders(context: ListingContext, section: string | null, title: string): StoragePolicyOtherFolder[] {
  return (context.foldersByTitle.get(canonicalTitleKey(title)) ?? [])
    .filter((other) => other !== section)
    .map((other) => ({ section: other, policy: knownPolicy(context.policies.get(storagePolicyKey(other, title))?.policy) }));
}

function serializeFolderTitle(
  context: ListingContext,
  section: string | null,
  fallbackTitle: string,
  row: PolicyRow | null,
  policyOverride?: StoragePolicyKind
): StoragePolicyTitle {
  const metadata = section ? context.metadata.get(storagePolicyKey(section, fallbackTitle)) : undefined;
  const title = metadata?.title ?? row?.title ?? fallbackTitle;
  return {
    id: row?.id ?? null,
    title,
    normalizedTitle: row?.normalizedTitle ?? normalizeTitle(title),
    section,
    policy: policyOverride ?? knownPolicy(row?.policy),
    category: categorizeSection(section, context.sectionTypes),
    sections: section ? [section] : [],
    otherFolders: otherFolders(context, section, title),
    sharedFileSections: section ? context.sharedFiles.get(storagePolicyKey(section, title)) ?? [] : [],
    linkCount: metadata?.linkCount ?? 0,
    remoteLinkCount: metadata?.remoteLinkCount ?? 0,
    localLinkCount: metadata?.localLinkCount ?? 0,
    fileCount: metadata?.fileCount ?? 0,
    remoteFileCount: metadata?.remoteFileCount ?? 0,
    localFileCount: metadata?.localFileCount ?? 0,
    sectionCount: section ? 1 : 0,
    source: row?.source ?? "scan",
    updatedAt: row?.updatedAt ?? null
  };
}

function compareFolderTitles(a: StoragePolicyTitle, b: StoragePolicyTitle): number {
  return a.title.localeCompare(b.title) || (a.section ?? "").localeCompare(b.section ?? "");
}

function uniqueTargets(targets: readonly StoragePolicyTarget[]): StoragePolicyTarget[] {
  const seen = new Set<string>();
  const result: StoragePolicyTarget[] = [];
  for (const target of targets) {
    const title = target.title.trim();
    const section = target.section.trim();
    if (!section || !canonicalTitleKey(title)) continue;
    const key = storagePolicyKey(section, title);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ section, title });
  }
  return result;
}

/**
 * Places saved policies whose title had no folder yet into every folder that now holds the title, then removes the
 * unplaced row. Scans call this before applying folder defaults, so a saved policy wins over a default.
 */
export async function resolveUnplacedStoragePolicies(db: Db, timestamp = nowIso()): Promise<number> {
  const unplaced = await first(db.select({ id: schema.storagePolicies.id }).from(schema.storagePolicies).where(eq(schema.storagePolicies.section, unplacedSection)).limit(1));
  if (!unplaced) return 0;
  const policies = await db.select().from(schema.storagePolicies);
  const linkTitles = await dbAll<{ section: string; itemName: string }>(db, sql`select distinct section, item_name as "itemName" from media_links`);
  const plan = planPolicyPlacement(policies, linkTitles);
  if (plan.deleteIds.length === 0) return 0;
  for (let offset = 0; offset < plan.inserts.length; offset += 500) {
    await db.insert(schema.storagePolicies).values(plan.inserts.slice(offset, offset + 500)).onConflictDoNothing();
  }
  await db.delete(schema.storagePolicies).where(inArray(schema.storagePolicies.id, plan.deleteIds));
  await syncStoragePolicyMediaLinksForKeys(db, new Map(plan.inserts.map((row) => [storagePolicyKey(row.section, row.normalizedTitle), knownPolicy(row.policy)])), timestamp);
  return plan.inserts.length;
}

async function syncStoragePolicyMediaLinksForKeys(db: Db, keyPolicies: Map<string, StoragePolicyKind>, timestamp: string, mediaLinkIds?: readonly number[]): Promise<void> {
  if (keyPolicies.size === 0) return;
  const policies = [...new Set(keyPolicies.values())];
  if (mediaLinkIds !== undefined && policies.length === 1) {
    const uniqueIds = [...new Set(mediaLinkIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      await db
        .update(schema.mediaLinks)
        .set({ storagePolicy: policies[0]!, updatedAt: timestamp })
        .where(inArray(schema.mediaLinks.id, uniqueIds.slice(offset, offset + 500)));
    }
  } else {
    const sections = [...new Set([...keyPolicies.keys()].map((key) => key.slice(0, key.indexOf("\u0000"))))];
    const byPolicy = new Map<StoragePolicyKind, number[]>();
    for (const link of await db
      .select({ id: schema.mediaLinks.id, section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName, storagePolicy: schema.mediaLinks.storagePolicy })
      .from(schema.mediaLinks)
      .where(inArray(schema.mediaLinks.section, sections))) {
      const policy = keyPolicies.get(storagePolicyKey(link.section, link.itemName));
      if (!policy || link.storagePolicy === policy) continue;
      byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), link.id]);
    }
    for (const [policy, ids] of byPolicy) {
      for (let offset = 0; offset < ids.length; offset += 500) {
        await db.update(schema.mediaLinks).set({ storagePolicy: policy, updatedAt: timestamp }).where(inArray(schema.mediaLinks.id, ids.slice(offset, offset + 500)));
      }
    }
  }
  await reconcileStorageFilePolicies(db, timestamp);
}

/** Assigns location 1 to every folder copy of a title that currently has a local link. */
export async function bootstrapLocalStoragePolicies(
  db: Db,
  options: { overwriteExisting?: boolean; source?: string } = {}
): Promise<LocalStoragePolicyBootstrapResult> {
  const overwriteExisting = options.overwriteExisting === true;
  const rows = await dbAll<{ section: string; title: string }>(db, sql`
    select ml.section, ml.item_name as title
    from media_links ml
    where ml.missing_since is null
      and ml.is_media = true
      and ml.kind = 'local'
    order by ml.section, lower(ml.item_name)
  `);
  const localTargets = uniqueTargets(rows.map((row) => ({ section: row.section, title: row.title })));
  const existing = policyRowsByKey(await db.select().from(schema.storagePolicies));
  const targets = overwriteExisting ? localTargets : localTargets.filter((target) => !existing.has(storagePolicyKey(target.section, target.title)));
  if (targets.length > 0) await setStoragePolicies(db, targets, "location_1", { source: options.source ?? "bootstrap" });
  return {
    foundLocalTitles: localTargets.length,
    assignedLocal: targets.length,
    skippedExistingPolicy: localTargets.length - targets.length
  };
}

/** One row per folder copy of a title. Without a filter, assigned rows and unassigned folder copies are both listed. */
export async function listStoragePolicyTitles(db: Db, policy?: StoragePolicyKind): Promise<StoragePolicyTitle[]> {
  const context = await getListingContext(db);
  const policyRows = policy === "unassigned" ? [] : [...context.policies.values()].filter((row) => !policy || row.policy === policy);
  const assigned = policyRows.map((row) => serializeFolderTitle(context, row.section || null, row.title, row));
  if (policy && policy !== "unassigned") return assigned.sort(compareFolderTitles);

  const unassigned = [...context.metadata.entries()]
    .filter(([key, row]) => row.linkCount > 0 && !context.policies.has(key))
    .map(([, row]) => serializeFolderTitle(context, row.section, row.title, null, "unassigned"));
  return [...assigned, ...unassigned].sort(compareFolderTitles);
}

export async function listStoragePolicyCandidates(db: Db, query = "", limit = 50): Promise<StoragePolicyCandidate[]> {
  const normalizedQuery = normalizeTitle(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const sectionTypes = await getSectionTypeLookup(db);
  const assignedKeys = policyRowsByKey(await db.select().from(schema.storagePolicies));
  return [...(await getFolderTitleMetadata(db)).entries()]
    .filter(([key, row]) => row.linkCount > 0 && !assignedKeys.has(key))
    .map(([, row]) => row)
    .filter((row) => {
      const haystack = normalizeTitle([row.title, row.section].join(" "));
      return tokens.every((token) => haystack.includes(token));
    })
    .sort((a, b) => {
      const aTitle = normalizeTitle(a.title);
      const bTitle = normalizeTitle(b.title);
      const aRank = aTitle === normalizedQuery ? 0 : aTitle.startsWith(tokens[0]) ? 1 : 2;
      const bRank = bTitle === normalizedQuery ? 0 : bTitle.startsWith(tokens[0]) ? 1 : 2;
      return aRank - bRank || a.title.localeCompare(b.title) || a.section.localeCompare(b.section);
    })
    .slice(0, boundedLimit)
    .map((row) => ({
      title: row.title,
      normalizedTitle: normalizeTitle(row.title),
      section: row.section,
      category: categorizeSection(row.section, sectionTypes),
      sections: [row.section],
      linkCount: row.linkCount,
      remoteLinkCount: row.remoteLinkCount,
      localLinkCount: row.localLinkCount,
      fileCount: row.fileCount,
      remoteFileCount: row.remoteFileCount,
      localFileCount: row.localFileCount,
      sectionCount: 1
    }));
}

/**
 * Resolves requested folder copies to ones the scanned library holds, spelled as the library spells them.
 * With `allFolders`, each title expands to every folder that holds it and any section given is ignored.
 */
export async function findStoragePolicyCandidateTargets(
  db: Db,
  requested: ReadonlyArray<{ title: string; section?: string | null }>,
  options: { allFolders?: boolean } = {}
): Promise<{ targets: StoragePolicyTarget[]; invalidTitles: string[] }> {
  const byKey = new Map<string, StoragePolicyTarget>();
  const byTitle = new Map<string, StoragePolicyTarget[]>();
  for (const row of (await getFolderTitleMetadata(db)).values()) {
    if (row.linkCount === 0) continue;
    const target = { section: row.section, title: row.title };
    byKey.set(storagePolicyKey(row.section, row.title), target);
    const titleKey = canonicalTitleKey(row.title);
    byTitle.set(titleKey, [...(byTitle.get(titleKey) ?? []), target]);
  }

  const targets: StoragePolicyTarget[] = [];
  const invalidTitles: string[] = [];
  for (const entry of requested) {
    const title = entry.title.trim();
    if (!canonicalTitleKey(title)) continue;
    if (options.allFolders) {
      const found = byTitle.get(canonicalTitleKey(title)) ?? [];
      if (found.length === 0) invalidTitles.push(title);
      targets.push(...found);
      continue;
    }
    const found = entry.section ? byKey.get(storagePolicyKey(entry.section.trim(), title)) : undefined;
    if (found) targets.push(found);
    else invalidTitles.push(entry.section ? `${title} (${entry.section})` : title);
  }
  return { targets: uniqueTargets(targets), invalidTitles: [...new Set(invalidTitles)] };
}

export async function syncStoragePolicyMediaLinks(db: Db, target: StoragePolicyTarget, policy: StoragePolicyKind): Promise<void> {
  await syncStoragePolicyMediaLinksForKeys(db, new Map([[storagePolicyKey(target.section, target.title), knownPolicy(policy)]]), nowIso());
}

/**
 * Sets the policy of each folder copy given, and only those: the same title in another folder keeps its own policy.
 * "unassigned" removes the folder's policy. Links in those folders follow, and storage files are reconciled.
 */
export async function setStoragePolicies(
  db: Db,
  targets: readonly StoragePolicyTarget[],
  policy: StoragePolicyKind,
  options: StoragePolicyChangeOptions = {}
): Promise<StoragePolicyBulkResult> {
  const unique = uniqueTargets(targets);
  const timestamp = nowIso();
  const source = options.source ?? "manual";

  if (unique.length > 0) {
    await db.transaction(async (transaction) => {
      await resolveUnplacedStoragePolicies(transaction, timestamp);
      const wanted = new Map(unique.map((target) => [storagePolicyKey(target.section, target.title), target]));
      const sections = [...new Set(unique.map((target) => target.section))];
      const existing = (await transaction.select().from(schema.storagePolicies).where(inArray(schema.storagePolicies.section, sections))).filter((row) =>
        wanted.has(storagePolicyKey(row.section, row.normalizedTitle))
      );
      if (policy === "unassigned") {
        if (existing.length > 0) await transaction.delete(schema.storagePolicies).where(inArray(schema.storagePolicies.id, existing.map((row) => row.id)));
      } else {
        const kept = policyRowsByKey(existing);
        const keptIds = new Set([...kept.values()].map((row) => row.id));
        const duplicateIds = existing.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
        if (duplicateIds.length > 0) await transaction.delete(schema.storagePolicies).where(inArray(schema.storagePolicies.id, duplicateIds));

        const updates = [...wanted.entries()].flatMap(([key, target]) => {
          const row = kept.get(key);
          return row ? [{ id: row.id, title: target.title, normalizedTitle: normalizeTitle(target.title) }] : [];
        });
        for (let offset = 0; offset < updates.length; offset += 500) {
          const updateRows = sql.join(
            updates.slice(offset, offset + 500).map((update) => sql`(${update.id}::integer, ${update.title}::text, ${update.normalizedTitle}::text)`),
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

        const inserts = [...wanted.entries()]
          .filter(([key]) => !kept.has(key))
          .map(([, target]) => ({ section: target.section, title: target.title, normalizedTitle: normalizeTitle(target.title), policy, source, updatedAt: timestamp }));
        for (let offset = 0; offset < inserts.length; offset += 500) {
          await transaction
            .insert(schema.storagePolicies)
            .values(inserts.slice(offset, offset + 500))
            .onConflictDoUpdate({
              target: [schema.storagePolicies.section, schema.storagePolicies.normalizedTitle],
              set: { title: sql`excluded.title`, policy, source, updatedAt: timestamp }
            });
        }
      }
      await syncStoragePolicyMediaLinksForKeys(transaction, new Map([...wanted.keys()].map((key) => [key, policy])), timestamp, options.mediaLinkIds);
    });
  }

  const context = await getListingContext(db);
  const items = unique.map((target) => {
    const row = context.policies.get(storagePolicyKey(target.section, target.title)) ?? null;
    if (policy !== "unassigned" && !row) throw new Error("Storage policy was not saved");
    return serializeFolderTitle(context, target.section, target.title, policy === "unassigned" ? null : row, policy === "unassigned" ? "unassigned" : undefined);
  });
  return { updated: items.length, policy, sections: [...new Set(unique.map((target) => target.section))].sort((a, b) => a.localeCompare(b)), items };
}

export async function setStoragePolicy(db: Db, target: StoragePolicyTarget, policy: StoragePolicyKind, options: StoragePolicyChangeOptions = {}): Promise<StoragePolicyTitle> {
  const result = await setStoragePolicies(db, [target], policy, options);
  if (result.items[0]) return result.items[0];
  const context = await getListingContext(db);
  return serializeFolderTitle(context, target.section, target.title, null, "unassigned");
}

export async function removeStoragePolicyTitle(db: Db, id: number): Promise<StoragePolicyTitle | null> {
  const existing = await first(db.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.id, id)).limit(1));
  if (!existing) return null;
  const context = await getListingContext(db);
  const serialized = serializeFolderTitle(context, existing.section || null, existing.title, existing);

  await db.delete(schema.storagePolicies).where(eq(schema.storagePolicies.id, id));
  if (existing.section) await syncStoragePolicyMediaLinks(db, { section: existing.section, title: existing.normalizedTitle }, "unassigned");
  return serialized;
}

/** Policy per folder key (`storagePolicyKey`), plus unplaced rows under the empty section for scans to fall back on. */
export async function getStoragePolicyLookup(db: Db): Promise<Map<string, StoragePolicyKind>> {
  const result = new Map<string, StoragePolicyKind>();
  for (const [key, row] of policyRowsByKey(await db.select().from(schema.storagePolicies))) {
    const policy = knownPolicy(row.policy);
    if (policy !== "unassigned" && canonicalTitleKey(row.normalizedTitle)) result.set(key, policy);
  }
  return result;
}

/** The policy one folder's copy of a title has, falling back to a saved policy not yet placed in any folder. */
export function storagePolicyFor(lookup: Map<string, StoragePolicyKind>, section: string, title: string): StoragePolicyKind {
  return lookup.get(storagePolicyKey(section, title)) ?? lookup.get(storagePolicyKey(unplacedSection, title)) ?? "unassigned";
}
