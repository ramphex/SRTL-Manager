import type { SectionContentType } from "./types";

export function inferSectionContentType(section: string): SectionContentType {
  const normalized = section.toLowerCase();
  if (normalized.includes("show") || normalized.includes("series") || normalized.includes("tv")) return "shows";
  if (normalized.includes("movie") || normalized.includes("film")) return "movies";
  return "other";
}

export function normalizeSectionContentType(value: unknown): SectionContentType | null {
  return value === "shows" || value === "movies" || value === "other" ? value : null;
}
