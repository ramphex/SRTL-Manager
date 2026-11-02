import type { JobRecord } from "../shared/types";
import { scanOptionsFromJob } from "./jobScopeLocks";

/** Adjacent jobs for one title are only merged when created within this long of each other. */
export const jobGroupWindowMs = 30 * 60 * 1000;

export type JobListEntry =
  | { kind: "job"; job: JobRecord }
  | { kind: "group"; key: string; jobs: JobRecord[]; summary: JobGroupSummary };

export interface JobGroupSummary {
  total: number;
  failed: number;
  completed: number;
  other: number;
  label: string;
}

function isActive(job: JobRecord): boolean {
  return job.status === "queued" || job.status === "running";
}

/** The single title a job covers, or null for multi-title, whole-section, or unscoped jobs. */
export function jobSingleTitleKey(job: JobRecord): string | null {
  if (isActive(job)) return null;
  if (job.type === "scan") {
    const scopes = scanOptionsFromJob(job)?.titleScopes;
    if (scopes?.length !== 1) return null;
    const [scope] = scopes;
    return `${job.type}\u0000${scope.section}\u0000${scope.itemName}`;
  }
  const selection = job.selection;
  if (!selection || selection.titles.length !== 1 || selection.omittedTitles || selection.unavailable > 0) return null;
  const [title] = selection.titles;
  return `${job.type}\u0000${title.section}\u0000${title.itemName}`;
}

export function summarizeJobGroup(jobs: JobRecord[]): JobGroupSummary {
  const failed = jobs.filter((job) => job.status === "failed" || job.status === "partially_failed").length;
  const completed = jobs.filter((job) => job.status === "completed").length;
  const other = jobs.length - failed - completed;
  const parts = [`${jobs.length} jobs`];
  if (failed > 0) parts.push(`${failed} failed`);
  else if (completed < jobs.length) parts.push(`${completed} completed`);
  return { total: jobs.length, failed, completed, other, label: parts.join(" · ") };
}

/**
 * Collapses runs of adjacent finished jobs with the same type and the exact same single title (created within
 * `jobGroupWindowMs` of the previous job in the run). Queued and running jobs are never grouped, so live progress
 * stays visible. Input order is preserved; a group's jobs keep list order, so the first one is the newest.
 */
export function groupAdjacentJobs(jobs: JobRecord[], windowMs: number = jobGroupWindowMs): JobListEntry[] {
  const entries: JobListEntry[] = [];
  let run: JobRecord[] = [];
  let runKey: string | null = null;
  const flush = () => {
    if (run.length === 1) entries.push({ kind: "job", job: run[0] });
    else if (run.length > 1) entries.push({ kind: "group", key: `group-${run[0].id}`, jobs: run, summary: summarizeJobGroup(run) });
    run = [];
    runKey = null;
  };
  for (const job of jobs) {
    const key = jobSingleTitleKey(job);
    const previous = run[run.length - 1];
    const gap = previous ? Math.abs(Date.parse(previous.createdAt) - Date.parse(job.createdAt)) : 0;
    if (key !== null && key === runKey && Number.isFinite(gap) && gap <= windowMs) {
      run.push(job);
      continue;
    }
    flush();
    if (key === null) {
      entries.push({ kind: "job", job });
    } else {
      run = [job];
      runKey = key;
    }
  }
  flush();
  return entries;
}
