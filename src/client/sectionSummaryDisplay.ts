import { inferSectionContentType } from "../shared/sections";
import type { InventorySummary, MediaLinkTreeNode, SectionContentType, SectionSummary } from "../shared/types";

type SectionTypeLike = {
  section: string;
  type?: SectionContentType | null;
};

type SectionCompositionLike = SectionTypeLike & {
  itemCount: number;
  seasonCount: number;
  episodeCount: number;
};

type InventoryPolicyNeededLike = Pick<InventorySummary, "unassignedRemoteLinks" | "unassignedLocalLinks">;

export type SectionCompositionPart = {
  value: number;
  unit: string;
};

export type LinkStatusWorkKind = "policy_needed" | "copy_to_local" | "copy_to_remote";

export type LinkStatusCount = {
  label: string;
  count: number;
  kind?: LinkStatusWorkKind;
};

function sectionType(section: SectionTypeLike): SectionContentType {
  return section.type ?? inferSectionContentType(section.section);
}

function pluralUnit(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function sectionActionUnit(section: SectionTypeLike, count: number): string {
  const type = sectionType(section);
  if (type === "shows") return pluralUnit(count, "episode");
  if (type === "movies") return pluralUnit(count, "movie");
  return pluralUnit(count, "item");
}

export function inventoryPolicyNeededCount(summary: InventoryPolicyNeededLike): number {
  return summary.unassignedRemoteLinks + summary.unassignedLocalLinks;
}

export function sectionCompositionParts(section: SectionCompositionLike): SectionCompositionPart[] {
  const type = sectionType(section);
  if (type === "shows") {
    return [
      { value: section.itemCount, unit: pluralUnit(section.itemCount, "show") },
      { value: section.seasonCount, unit: pluralUnit(section.seasonCount, "season") },
      { value: section.episodeCount, unit: pluralUnit(section.episodeCount, "episode") }
    ];
  }

  const primaryUnit = type === "movies" ? pluralUnit(section.itemCount, "movie") : pluralUnit(section.itemCount, "title");
  const parts = [{ value: section.itemCount, unit: primaryUnit }];
  if (section.episodeCount !== section.itemCount) parts.push({ value: section.episodeCount, unit: pluralUnit(section.episodeCount, "file") });
  return parts;
}

export function orderSectionSummaries(sections: SectionSummary[], sectionOrder: string[] | undefined): SectionSummary[] {
  if (!sectionOrder || sectionOrder.length === 0) return sections;

  const configuredOrder = new Map(sectionOrder.map((section, index) => [section, index]));
  const originalOrder = new Map(sections.map((section, index) => [section.section, index]));

  return [...sections].sort((first, second) => {
    const firstConfiguredIndex = configuredOrder.get(first.section);
    const secondConfiguredIndex = configuredOrder.get(second.section);
    if (firstConfiguredIndex != null && secondConfiguredIndex != null) return firstConfiguredIndex - secondConfiguredIndex;
    if (firstConfiguredIndex != null) return -1;
    if (secondConfiguredIndex != null) return 1;
    return (originalOrder.get(first.section) ?? 0) - (originalOrder.get(second.section) ?? 0);
  });
}

export function mediaLinkTreeStatusCounts(node: Pick<MediaLinkTreeNode, "remoteLinks" | "localLinks" | "brokenLinks" | "otherLinks" | "nonMediaLinks" | "actionableRemoteLinks" | "actionableLocalLinks" | "assignedRemoteLinks" | "unassignedRemoteLinks" | "unassignedLocalLinks">): LinkStatusCount[] {
  const policyNeededLinks = node.unassignedRemoteLinks + node.unassignedLocalLinks;
  const assignedRemoteLinks = node.actionableRemoteLinks + node.assignedRemoteLinks + node.unassignedRemoteLinks;
  const assignedLocalLinks = node.actionableLocalLinks + node.unassignedLocalLinks;
  const settledRemoteLinks = Math.max(0, node.remoteLinks - assignedRemoteLinks);
  const settledLocalLinks = Math.max(0, node.localLinks - assignedLocalLinks);

  const counts: LinkStatusCount[] = [
    { label: "Unassigned", count: policyNeededLinks, kind: "policy_needed" },
    { label: "Copy To Local", count: node.actionableRemoteLinks, kind: "copy_to_local" },
    { label: "Copy To Remote", count: node.actionableLocalLinks, kind: "copy_to_remote" },
    { label: "broken", count: node.brokenLinks },
    { label: "Location 2", count: node.assignedRemoteLinks },
    { label: "Local", count: settledLocalLinks },
    { label: "Remote", count: settledRemoteLinks },
    { label: "other", count: node.otherLinks },
    { label: "non_media", count: node.nonMediaLinks }
  ];

  return counts.filter(({ count }) => count > 0);
}
