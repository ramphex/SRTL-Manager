import type { PoolClient } from "pg";

// Postgres side of the shared normaliser in src/shared/search.ts. It only has to be close enough for a prefilter:
// the server runs the real matcher on every row that passes, so the column must never drop or change a letter the
// shared normaliser keeps. Extra leftover symbols are harmless, because query pieces never contain separators.
const apostrophes = "'‘’‛ʼʹ`´";
const combiningMarks = "[\\u0300-\\u036f\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]";
const asciiSeparators = "\\x01-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7f";
const unicodeSeparators = "\\u00a0-\\u00bf\\u00d7\\u00f7\\u2000-\\u206f\\u3000-\\u303f";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The normalising expression over a text expression. UTF-8 databases also fold accents; others fold case and symbols only. */
export function searchTextExpression(source: string, utf8: boolean): string {
  if (!utf8) {
    return `btrim(regexp_replace(lower(translate(${source}, '''\`', '')), ${literal(`[${asciiSeparators}]+`)}, ' ', 'g'))`;
  }
  const withoutApostrophes = `translate(${source}, ${literal(apostrophes)}, '')`;
  let folded = `regexp_replace(normalize(${withoutApostrophes}, NFKD), ${literal(combiningMarks)}, '', 'g')`;
  folded = `translate(${folded}, 'øØđĐðÐłŁı', 'ooddddlli')`;
  for (const [letter, replacement] of [["ß", "ss"], ["ẞ", "ss"], ["æ", "ae"], ["Æ", "ae"], ["œ", "oe"], ["Œ", "oe"], ["þ", "th"], ["Þ", "th"]]) {
    folded = `replace(${folded}, ${literal(letter!)}, ${literal(replacement!)})`;
  }
  return `btrim(regexp_replace(lower(${folded}), ${literal(`[${asciiSeparators}${unicodeSeparators}]+`)}, ' ', 'g'))`;
}

/**
 * Adds media_links.search_text, kept up to date by Postgres from the title, relative path and the end of the target path, so every writer stays
 * in step without code changes and searches do not normalise 70,000 rows on every keystroke.
 */
export async function applySearchTextMigration(client: PoolClient): Promise<void> {
  // Every real install has these columns from the first migration; only partial test schemas lack them.
  const columns = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media_links' AND column_name IN ('item_name', 'relative_path', 'target_path')"
  );
  if (columns.rows.length < 3) return;
  const encoding = (await client.query<{ server_encoding: string }>("SHOW server_encoding")).rows[0]?.server_encoding ?? "";
  // The link path is only the section folder plus the relative path. Of the target, only the release folder and file
  // name say anything; its storage root is shared by every row and would let a near-miss word match them all.
  const source = `item_name || ' ' || relative_path || ' ' || coalesce(substring(target_path from '([^/]*/[^/]*)$'), target_path)`;
  await client.query(`ALTER TABLE media_links ADD COLUMN IF NOT EXISTS search_text TEXT GENERATED ALWAYS AS (${searchTextExpression(source, encoding.toUpperCase() === "UTF8")}) STORED`);
}
