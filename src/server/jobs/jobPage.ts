import { and, eq, gte, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { activeJobStatuses, jobSearchTerms, jobStatuses, jobStatusesMatching, jobTypesMatching, terminalJobStatuses } from "../../shared/jobLabels";
import type { JobType } from "../../shared/types";

export interface JobPageQuery {
  /** Without a search, finished jobs older than this are left out; active jobs always show. */
  completedSince?: string;
  /** Words matched against each job's id, type, status, options and selected titles. A search covers every job. */
  search?: string;
  offset?: number;
  limit?: number;
  /** Types whose options and titles this account may not see, so a search must not match on them either. */
  detailHiddenTypes?: readonly JobType[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Matches one search word anywhere the Recent jobs list shows text for a job. */
function jobSearchTermCondition(term: string, detailHiddenTypes: readonly JobType[]): SQL {
  // "#123" asks for one job by id and nothing else.
  const explicitId = /^#(\d{1,9})$/.exec(term);
  if (explicitId) return eq(schema.jobs.id, Number(explicitId[1]));
  const matches: SQL[] = [];
  if (/^\d{1,9}$/.test(term)) matches.push(eq(schema.jobs.id, Number(term)));
  const types = jobTypesMatching(term);
  if (types.length > 0) matches.push(inArray(schema.jobs.type, types));
  const statuses = jobStatusesMatching(term);
  if (statuses.length > 0) matches.push(inArray(schema.jobs.status, statuses));

  const contains = `%${escapeLike(term)}%`;
  // Options are stored as compact JSON, where link ids and counts are bare numbers after ":", "[" or ",". A number
  // only matches elsewhere (inside a folder or title name), or every search for a year would match most copies.
  const optionsMatch = /^\d+$/.test(term)
    ? sql`${schema.jobs.options} ~ ${`(^|[^0-9:\\[,])${term}`}`
    : ilike(schema.jobs.options, contains);
  const titleMatch = sql`EXISTS (
    SELECT 1 FROM ${schema.jobSelectionItems}
    WHERE ${schema.jobSelectionItems.jobId} = ${schema.jobs.id}
      AND (${schema.jobSelectionItems.itemName} ILIKE ${contains} OR ${schema.jobSelectionItems.section} ILIKE ${contains})
  )`;
  const detailsVisible = detailHiddenTypes.length > 0 ? notInArray(schema.jobs.type, [...detailHiddenTypes]) : undefined;
  matches.push(and(detailsVisible, or(optionsMatch, titleMatch)) as SQL);
  return or(...matches) as SQL;
}

/** The WHERE and ORDER BY of one page of the Recent jobs list. */
export function jobPageConditions(query: JobPageQuery): { where: SQL; orderBy: SQL[] } {
  const terms = jobSearchTerms(query.search);
  const active = inArray(schema.jobs.status, [...activeJobStatuses]);
  const conditions: SQL[] = [];
  if (terms.length > 0) {
    conditions.push(inArray(schema.jobs.status, [...jobStatuses]));
    for (const term of terms) conditions.push(jobSearchTermCondition(term, query.detailHiddenTypes ?? []));
  } else if (query.completedSince) {
    conditions.push(or(active, and(inArray(schema.jobs.status, [...terminalJobStatuses]), gte(schema.jobs.finishedAt, query.completedSince))) as SQL);
  } else {
    conditions.push(inArray(schema.jobs.status, [...jobStatuses]));
  }
  return {
    where: and(...conditions) as SQL,
    orderBy: [sql`CASE WHEN ${active} THEN 0 ELSE 1 END`, sql`${schema.jobs.id} DESC`]
  };
}
