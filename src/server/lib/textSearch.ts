import { sql, type SQL } from "drizzle-orm";
import { matchSearchTerms, normalizeSearchText, searchTermPieces, type SearchTerm } from "../../shared/search";

function containsPattern(piece: string): string {
  return `%${piece.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * A cheap SQL test that every row matching the terms passes: for each term, at least one of its pieces appears in the
 * normalised column. Rows that pass still need matchesNormalizedSearch, which runs the real matcher.
 */
export function searchPrefilter(column: SQL, terms: SearchTerm[]): SQL | undefined {
  if (terms.length === 0) return undefined;
  const clauses = terms.map((term) => sql`(${sql.join(searchTermPieces(term).map((piece) => sql`${column} like ${containsPattern(piece)}`), sql` or `)})`);
  return sql`(${sql.join(clauses, sql` and `)})`;
}

/** Runs the shared matcher on text the database already normalised; normalising again folds anything it left. */
export function matchesNormalizedSearch(terms: SearchTerm[], text: string | null): boolean {
  return matchSearchTerms(terms, normalizeSearchText(text ?? "")) !== null;
}
