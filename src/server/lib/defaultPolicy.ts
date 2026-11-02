import { and, eq, inArray, isNull } from "drizzle-orm";
import { getSectionSettings, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { DefaultPolicyApplyResult, DefaultPolicyPreview, DefaultStoragePolicy, SectionSettings, StoragePolicyKind } from "../../shared/types";
import { canonicalTitleKey, setStoragePolicyTitles } from "./storagePolicies";

export const defaultPolicySource = "default";

export interface DefaultPolicyTitle {
  section: string;
  itemName: string;
}

export interface DefaultPolicyAssignment {
  assignedLocal: number;
  assignedRemote: number;
  skippedForReview: number;
}

// An integration that tags titles itself returns the titles whose tags already disagree with the default,
// so the default does not fight a policy someone chose there. Radarr is the first; Sonarr can add its own.
type ReviewCheck = (db: Db, itemNames: string[], policy: DefaultStoragePolicy) => Promise<Set<string>>;

const reviewChecks: ReviewCheck[] = [
  async (db, itemNames, policy) => (await import("./radarr")).radarrTagConflictTitles(db, itemNames, policy)
];

export function sectionDefaultPolicy(settings: Pick<SectionSettings, "sectionDefaultPolicies">, section: string): DefaultStoragePolicy | null {
  return settings.sectionDefaultPolicies?.[section] ?? null;
}

async function policyTitleKeys(db: Db): Promise<Set<string>> {
  return new Set((await db.select({ normalizedTitle: schema.storagePolicies.normalizedTitle }).from(schema.storagePolicies)).map((row) => canonicalTitleKey(row.normalizedTitle)));
}

async function titlesInReview(db: Db, itemNames: string[], policy: DefaultStoragePolicy): Promise<Set<string>> {
  const review = new Set<string>();
  for (const check of reviewChecks) for (const key of await check(db, itemNames, policy)) review.add(key);
  return review;
}

// Assigns each policy to its titles with source "default". Titles that already have a policy or are in review elsewhere are skipped.
async function assignDefaults(db: Db, byPolicy: Map<DefaultStoragePolicy, string[]>): Promise<DefaultPolicyAssignment> {
  const result: DefaultPolicyAssignment = { assignedLocal: 0, assignedRemote: 0, skippedForReview: 0 };
  const hasPolicy = await policyTitleKeys(db);
  for (const [policy, itemNames] of byPolicy) {
    const open = itemNames.filter((itemName) => !hasPolicy.has(canonicalTitleKey(itemName)));
    if (open.length === 0) continue;
    const review = await titlesInReview(db, open, policy);
    const titles = open.filter((itemName) => !review.has(canonicalTitleKey(itemName)));
    result.skippedForReview += open.length - titles.length;
    if (titles.length === 0) continue;
    const titleKeys = new Set(titles.map(canonicalTitleKey));
    const linkIds: number[] = [];
    for (const link of await db.select({ id: schema.mediaLinks.id, itemName: schema.mediaLinks.itemName }).from(schema.mediaLinks).where(inArray(schema.mediaLinks.itemName, titles))) {
      if (titleKeys.has(canonicalTitleKey(link.itemName))) linkIds.push(link.id);
    }
    await setStoragePolicyTitles(db, titles, policy, { source: defaultPolicySource, mediaLinkIds: linkIds });
    if (policy === "location_1") result.assignedLocal += titles.length;
    else result.assignedRemote += titles.length;
  }
  return result;
}

// `newTitles` are the titles that appeared for the first time in the scan being persisted. A title seen in several
// folders only gets a default when every folder agrees on it.
export async function applyDefaultPoliciesToNewTitles(db: Db, newTitles: DefaultPolicyTitle[], jobId: number): Promise<DefaultPolicyAssignment | null> {
  if (newTitles.length === 0) return null;
  const settings = await getSectionSettings(db);
  if (!Object.keys(settings.sectionDefaultPolicies ?? {}).length) return null;

  const titles = new Map<string, { itemName: string; defaults: Set<StoragePolicyKind> }>();
  for (const { section, itemName } of newTitles) {
    const key = canonicalTitleKey(itemName);
    if (!key) continue;
    const title = titles.get(key) ?? { itemName, defaults: new Set<StoragePolicyKind>() };
    title.defaults.add(sectionDefaultPolicy(settings, section) ?? "unassigned");
    titles.set(key, title);
  }
  const byPolicy = new Map<DefaultStoragePolicy, string[]>();
  for (const { itemName, defaults } of titles.values()) {
    const [policy] = defaults;
    if (defaults.size !== 1 || policy === "unassigned" || !policy) continue;
    byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), itemName]);
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
  const hasPolicy = await policyTitleKeys(db);
  const links = await db
    .select({ itemName: schema.mediaLinks.itemName })
    .from(schema.mediaLinks)
    .where(and(eq(schema.mediaLinks.section, section), eq(schema.mediaLinks.isMedia, true), isNull(schema.mediaLinks.missingSince)));
  const titles = new Map<string, string>();
  for (const { itemName } of links) {
    const key = canonicalTitleKey(itemName);
    if (key && !hasPolicy.has(key) && !titles.has(key)) titles.set(key, itemName);
  }
  return [...titles.values()].sort((a, b) => a.localeCompare(b));
}

export class DefaultPolicyRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

async function configuredDefault(db: Db, section: string): Promise<DefaultStoragePolicy> {
  const policy = sectionDefaultPolicy(await getSectionSettings(db), section);
  if (!policy) throw new DefaultPolicyRequestError(400, "Save a default policy for this folder first.");
  return policy;
}

export async function previewDefaultPolicyForUnassigned(db: Db, section: string): Promise<DefaultPolicyPreview> {
  const policy = await configuredDefault(db, section);
  const titles = await listUnassignedSectionTitles(db, section);
  const review = await titlesInReview(db, titles, policy);
  return {
    section,
    policy,
    unassignedTitles: titles.filter((itemName) => !review.has(canonicalTitleKey(itemName))).length,
    radarrReviewTitles: titles.filter((itemName) => review.has(canonicalTitleKey(itemName))).length
  };
}

export async function applyDefaultPolicyToUnassigned(db: Db, section: string): Promise<DefaultPolicyApplyResult> {
  const policy = await configuredDefault(db, section);
  const result = await assignDefaults(db, new Map([[policy, await listUnassignedSectionTitles(db, section)]]));
  return { section, policy, assigned: result.assignedLocal + result.assignedRemote, skippedForRadarrReview: result.skippedForReview };
}
