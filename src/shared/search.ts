// Forgiving search shared by every search box, in the browser and on the server.
//
// Text and queries go through the same normaliser: case and accents are ignored, apostrophes vanish, and every other
// symbol (dots, underscores, dashes, brackets) becomes a space. The query is split into words, and every word has to
// match somewhere, in any order. A word matches when it appears anywhere in the text, or, for longer words without
// digits, when it is within a small edit distance of the start of some word in the text. Episode codes, years and
// other words with digits only ever match exactly.

export interface SearchTerm {
  text: string;
  maxEdits: number;
}

export type SearchMatch = "exact" | "fuzzy";

const apostrophes = /['‘’‛ʼʹ`´]/g;
const combiningMarks = /\p{M}+/gu;
const separators = /[^\p{L}\p{N}]+/gu;
// Letters with no decomposition into a base letter and an accent.
const standaloneLetters: Record<string, string> = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ð": "d", "ł": "l", "þ": "th", "ı": "i" };
const standaloneLetterPattern = /[ßæœøđðłþı]/g;

const normalizedCacheLimit = 20_000;
const normalizedCache = new Map<string, string>();

/** Lower case, no accents, no apostrophes, and single spaces between words. */
export function normalizeSearchText(value: string): string {
  const cached = normalizedCache.get(value);
  if (cached !== undefined) return cached;
  const normalized = value
    .replace(apostrophes, "")
    .normalize("NFKD")
    .replace(combiningMarks, "")
    .toLowerCase()
    .replace(standaloneLetterPattern, (letter) => standaloneLetters[letter] ?? letter)
    .replace(separators, " ")
    .trim();
  if (normalizedCache.size >= normalizedCacheLimit) normalizedCache.clear();
  normalizedCache.set(value, normalized);
  return normalized;
}

/** Edits allowed for one query word: none for short words or anything with a digit, 1 for 5 to 8 letters, 2 beyond. */
export function allowedSearchEdits(word: string): number {
  if (/\p{N}/u.test(word)) return 0;
  const length = word.length;
  if (length >= 9) return 2;
  if (length >= 5) return 1;
  return 0;
}

/** The words of a query. An empty list means there is nothing to search for, so every item is shown. */
export function parseSearchQuery(query: string): SearchTerm[] {
  const words = normalizeSearchText(query).split(" ").filter(Boolean);
  return [...new Set(words)].map((text) => ({ text, maxEdits: allowedSearchEdits(text) }));
}

/** Whether normalised text matches every term, and how: "exact" when every word appears as typed. */
export function matchSearchTerms(terms: SearchTerm[], normalizedText: string): SearchMatch | null {
  if (terms.length === 0) return "exact";
  let words: string[] | null = null;
  let match: SearchMatch = "exact";
  for (const term of terms) {
    if (normalizedText.includes(term.text)) continue;
    if (term.maxEdits === 0) return null;
    words ??= normalizedText.split(" ");
    if (!words.some((word) => startsWithinEdits(term.text, word, term.maxEdits))) return null;
    match = "fuzzy";
  }
  return match;
}

type SearchField = string | number | null | undefined | false;

/** Normalises the fields of one item into a single searchable text. */
export function searchableText(...fields: SearchField[]): string {
  return normalizeSearchText(fields.filter((field) => field !== null && field !== undefined && field !== false && field !== "").join(" "));
}

/** The last segments of a path: a target's release folder and file name, without the storage root every row shares. */
export function pathTail(value: string | null | undefined, segments = 2): string | undefined {
  if (!value) return undefined;
  return value.split(/[\\/]/).filter(Boolean).slice(-segments).join("/");
}

/**
 * Builds a matcher for one query. Returns null when the query has no words, so callers can keep their list untouched.
 * The matcher takes the item's fields and says whether they match.
 */
export function createSearchMatcher(query: string): ((...fields: SearchField[]) => boolean) | null {
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return null;
  return (...fields) => matchSearchTerms(terms, searchableText(...fields)) !== null;
}

/**
 * Filters a list by a query, keeping its order. With rankExactFirst, items whose words all appear as typed come before
 * items that only matched with a typo; the order inside each group stays the same.
 */
export function filterBySearch<T>(items: T[], query: string, fields: (item: T) => SearchField[], options: { rankExactFirst?: boolean } = {}): T[] {
  const terms = parseSearchQuery(query);
  if (terms.length === 0) return items;
  const exact: T[] = [];
  const fuzzy: T[] = [];
  for (const item of items) {
    const match = matchSearchTerms(terms, searchableText(...fields(item)));
    if (match === "exact" || (match === "fuzzy" && !options.rankExactFirst)) exact.push(item);
    else if (match === "fuzzy") fuzzy.push(item);
  }
  return fuzzy.length > 0 ? [...exact, ...fuzzy] : exact;
}

/**
 * Pieces of a term, at least one of which must appear unchanged in any text the term matches, so the server can
 * prefilter rows with plain LIKE tests and only run the edit distance on the rows that pass. A match with k edits
 * leaves at least one of k + 1 pieces untouched, as long as one letter is left out between pieces: otherwise a swap of
 * the two letters either side of a boundary would break two pieces with one edit.
 */
export function searchTermPieces(term: SearchTerm): string[] {
  const parts = term.maxEdits + 1;
  if (parts <= 1) return [term.text];
  const letters = term.text.length - term.maxEdits;
  const pieces: string[] = [];
  let start = 0;
  for (let index = 0; index < parts; index += 1) {
    const size = Math.floor(letters / parts) + (index < letters % parts ? 1 : 0);
    pieces.push(term.text.slice(start, start + size));
    start += size + 1;
  }
  return [...new Set(pieces.filter(Boolean))];
}

let previousPreviousRow = new Int32Array(32);
let previousRow = new Int32Array(32);
let currentRow = new Int32Array(32);

/**
 * Whether some start of the word is within maxEdits of the term (Levenshtein distance with swapped neighbours counted
 * as one edit). Checking starts rather than whole words keeps half-typed words matching, as a plain substring would.
 */
export function startsWithinEdits(term: string, word: string, maxEdits: number): boolean {
  const termLength = term.length;
  if (word.length < termLength - maxEdits) return false;
  const wordLength = Math.min(word.length, termLength + maxEdits);
  if (previousRow.length <= termLength) {
    previousPreviousRow = new Int32Array(termLength + 1);
    previousRow = new Int32Array(termLength + 1);
    currentRow = new Int32Array(termLength + 1);
  }
  for (let index = 0; index <= termLength; index += 1) previousRow[index] = index;
  let previousMinimum = 0;
  for (let wordIndex = 1; wordIndex <= wordLength; wordIndex += 1) {
    const wordCode = word.charCodeAt(wordIndex - 1);
    currentRow[0] = wordIndex;
    let rowMinimum = wordIndex;
    for (let termIndex = 1; termIndex <= termLength; termIndex += 1) {
      const termCode = term.charCodeAt(termIndex - 1);
      let value = Math.min(previousRow[termIndex]! + 1, currentRow[termIndex - 1]! + 1, previousRow[termIndex - 1]! + (termCode === wordCode ? 0 : 1));
      if (termIndex > 1 && wordIndex > 1 && termCode === word.charCodeAt(wordIndex - 2) && term.charCodeAt(termIndex - 2) === wordCode) {
        value = Math.min(value, previousPreviousRow[termIndex - 2]! + 1);
      }
      currentRow[termIndex] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (currentRow[termLength]! <= maxEdits) return true;
    // Each cell grows from this row or the one before it, so once both are past the limit nothing later can match.
    if (rowMinimum > maxEdits && previousMinimum > maxEdits) return false;
    previousMinimum = rowMinimum;
    const recycled = previousPreviousRow;
    previousPreviousRow = previousRow;
    previousRow = currentRow;
    currentRow = recycled;
  }
  return false;
}
