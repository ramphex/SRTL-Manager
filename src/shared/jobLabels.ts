import type { JobStatus, JobType } from "./types";

/** The name each job type is shown with. The jobs search matches these, so a search finds what the list says. */
export const jobTypeLabels: Readonly<Record<JobType, string>> = {
  scan: "Inventory scan",
  audit: "Audit",
  copy: "Copy",
  symlink_cleanup: "Symlink cleanup",
  orphan_purge: "Orphan purge",
  orphan_restore: "Held file restore",
  partial_copy_discard: "Partial copy discard",
  path_migration: "Path migration",
  watch_sync: "Watch sync",
  backup: "Database backup"
};

export const jobTypes = Object.keys(jobTypeLabels) as JobType[];

export const activeJobStatuses: readonly JobStatus[] = ["queued", "running"];
export const terminalJobStatuses: readonly JobStatus[] = ["completed", "partially_failed", "failed", "cancelled"];
export const jobStatuses: readonly JobStatus[] = [...activeJobStatuses, ...terminalJobStatuses];

/** The Recent jobs list loads this many jobs at a time. */
export const jobPageSize = 10;
/** The most jobs one page request may ask for. */
export const maxJobPageSize = 50;
/** Longer searches are refused rather than cut, so a pasted log line fails loudly. */
export const maxJobSearchLength = 200;
/** Words past this many are ignored: each one adds a condition to the query. */
export const maxJobSearchTerms = 8;

/** Splits a jobs search into lowercase words; every word has to match the job somewhere. */
export function jobSearchTerms(search: string | null | undefined): string[] {
  if (!search) return [];
  return search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxJobSearchTerms);
}

/** Job types whose key or shown name contains the word. */
export function jobTypesMatching(term: string): JobType[] {
  const word = term.toLowerCase();
  return jobTypes.filter((type) => type.includes(word) || type.replaceAll("_", " ").includes(word) || jobTypeLabels[type].toLowerCase().includes(word));
}

/** Statuses whose key or shown text (underscores read as spaces) contains the word. */
export function jobStatusesMatching(term: string): JobStatus[] {
  const word = term.toLowerCase();
  return jobStatuses.filter((status) => status.includes(word) || status.replaceAll("_", " ").includes(word));
}
