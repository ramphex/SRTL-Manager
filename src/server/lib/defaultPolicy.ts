import { and, eq, isNull } from "drizzle-orm";
import { getSectionSettings, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { DefaultPolicyApplyResult, DefaultPolicyPreview, DefaultStoragePolicy, SectionSettings } from "../../shared/types";
import { AppError } from "../errors";
import { canonicalTitleKey, setStoragePolicies, storagePolicyKey, unplacedSection } from "./storagePolicies";

export const defaultPolicySource = "default";

/** One folder's copy of a title. Defaults are per folder, so each copy gets its own folder's default. */
export interface DefaultPolicyTitle {
  section: string;
  itemName: string;
}

export interface DefaultPolicyAssignment {
  assignedLocal: number;
  assignedRemote: number;
  skippedForReview: number;
}

// An integration that tags titles itself returns the folder keys (`storagePolicyKey`) whose tags already disagree
// with the default, so the default does not fight a policy someone chose there.
type ReviewCheck = (db: Db, titles: DefaultPolicyTitle[], policy: DefaultStoragePolicy) => Promise<Set<string>>;

const reviewChecks: ReviewCheck[] = [
  async (db, titles, policy) => (await import("./radarr")).radarrTagConflictTitles(db, titles, policy)
];

export function sectionDefaultPolicy(settings: Pick<SectionSettings, "sectionDefaultPolicies">, section: string): DefaultStoragePolicy | null {
  return settings.sectionDefaultPolicies?.[section] ?? null;
}

// Folder keys that already have a policy. A saved policy not placed in a folder yet counts for every folder.
async function policyKeys(db: Db): Promise<{ has(section: string, itemName: string): boolean }> {
  const keys = new Set<string>();
  const unplaced = new Set<string>();
  for (const row of await db.select({ section: schema.storagePolicies.section, normalizedTitle: schema.storagePolicies.normalizedTitle }).from(schema.storagePolicies)) {
    if (row.section === unplacedSection) unplaced.add(canonicalTitleKey(row.normalizedTitle));
    else keys.add(storagePolicyKey(row.section, row.normalizedTitle));
  }
  return { has: (section, itemName) => keys.has(storagePolicyKey(section, itemName)) || unplaced.has(canonicalTitleKey(itemName)) };
}

async function titlesInReview(db: Db, titles: DefaultPolicyTitle[], policy: DefaultStoragePolicy): Promise<Set<string>> {
  const review = new Set<string>();
  for (const check of reviewChecks) for (const key of await check(db, titles, policy)) review.add(key);
  return review;
}

// Assigns each policy to its folder copies with source "default". Copies that already have a policy or are in review elsewhere are skipped.
async function assignDefaults(db: Db, byPolicy: Map<DefaultStoragePolicy, DefaultPolicyTitle[]>): Promise<DefaultPolicyAssignment> {
  const result: DefaultPolicyAssignment = { assignedLocal: 0, assignedRemote: 0, skippedForReview: 0 };
  const hasPolicy = await policyKeys(db);
  for (const [policy, titles] of byPolicy) {
    const open = titles.filter((title) => !hasPolicy.has(title.section, title.itemName));
    if (open.length === 0) continue;
    const review = await titlesInReview(db, open, policy);
    const assign = open.filter((title) => !review.has(storagePolicyKey(title.section, title.itemName)));
    result.skippedForReview += open.length - assign.length;
    if (assign.length === 0) continue;
    await setStoragePolicies(db, assign.map((title) => ({ section: title.section, title: title.itemName })), policy, { source: defaultPolicySource });
    if (policy === "location_1") result.assignedLocal += assign.length;
    else result.assignedRemote += assign.length;
  }
  return result;
}

// `newTitles` are the folder copies that appeared for the first time in the scan being persisted. Each gets the
// default of its own folder, so the same title can get different defaults in different folders.
export async function applyDefaultPoliciesToNewTitles(db: Db, newTitles: DefaultPolicyTitle[], jobId: number): Promise<DefaultPolicyAssignment | null> {
  if (newTitles.length === 0) return null;
  const settings = await getSectionSettings(db);
  if (!Object.keys(settings.sectionDefaultPolicies ?? {}).length) return null;

  const byPolicy = new Map<DefaultStoragePolicy, DefaultPolicyTitle[]>();
  const seen = new Set<string>();
  for (const title of newTitles) {
    const key = storagePolicyKey(title.section, title.itemName);
    const policy = sectionDefaultPolicy(settings, title.section);
    if (!policy || !canonicalTitleKey(title.itemName) || seen.has(key)) continue;
    seen.add(key);
    byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), title]);
  }
  if (byPolicy.size === 0) return null;

  const result = await assignDefaults(db, byPolicy);
  const assigned = result.assignedLocal + result.assignedRemote;
  if (assigned > 0 || result.skippedForReview > 0) {
    await db.insert(schema.jobEvents).values({
      jobId,
      timestamp: nowIso(),
      level: "info",
      message: assigned > 0 ? `Default storage policy assigned to ${assigned} new title${assigned === 1 ? "" : "s"}` : "New titles left for Radarr review",
      data: JSON.stringify({ source: defaultPolicySource, ...result })
    });
  }
  return result;
}

export async function listUnassignedSectionTitles(db: Db, section: string): Promise<string[]> {
  const hasPolicy = await policyKeys(db);
  const links = await db
    .select({ itemName: schema.mediaLinks.itemName })
    .from(schema.mediaLinks)
    .where(and(eq(schema.mediaLinks.section, section), eq(schema.mediaLinks.isMedia, true), isNull(schema.mediaLinks.missingSince)));
  const titles = new Map<string, string>();
  for (const { itemName } of links) {
    const key = canonicalTitleKey(itemName);
    if (key && !hasPolicy.has(section, itemName) && !titles.has(key)) titles.set(key, itemName);
  }
  return [...titles.values()].sort((a, b) => a.localeCompare(b));
}

export class DefaultPolicyRequestError extends AppError {
  constructor(statusCode: number, message: string) {
    super(message, statusCode);
  }
}

async function configuredDefault(db: Db, section: string): Promise<DefaultStoragePolicy> {
  const policy = sectionDefaultPolicy(await getSectionSettings(db), section);
  if (!policy) throw new DefaultPolicyRequestError(400, "Save a default policy for this folder first.");
  return policy;
}

export async function previewDefaultPolicyForUnassigned(db: Db, section: string): Promise<DefaultPolicyPreview> {
  const policy = await configuredDefault(db, section);
  const titles = (await listUnassignedSectionTitles(db, section)).map((itemName) => ({ section, itemName }));
  const review = await titlesInReview(db, titles, policy);
  const inReview = titles.filter((title) => review.has(storagePolicyKey(section, title.itemName))).length;
  return { section, policy, unassignedTitles: titles.length - inReview, radarrReviewTitles: inReview };
}

export async function applyDefaultPolicyToUnassigned(db: Db, section: string): Promise<DefaultPolicyApplyResult> {
  const policy = await configuredDefault(db, section);
  const titles = (await listUnassignedSectionTitles(db, section)).map((itemName) => ({ section, itemName }));
  const result = await assignDefaults(db, new Map([[policy, titles]]));
  return { section, policy, assigned: result.assignedLocal + result.assignedRemote, skippedForRadarrReview: result.skippedForReview };
}
