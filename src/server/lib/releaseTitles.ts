import path from "node:path";

export interface LibraryTitle {
  itemName: string;
  // True for a shows section, false for a movies section, null when the section could hold either.
  isShow: boolean | null;
  // Whatever the caller needs to find this title again; the same name can be in more than one section.
  key?: string;
}

export interface IndexedTitle extends LibraryTitle {
  year: number | null;
  country: string | null;
  // Filed under another spelling of its name, such as without its country tag.
  isAlternate: boolean;
}

export type TitleIndex = Map<string, IndexedTitle[]>;

interface Candidate {
  name: string;
  year: number | null;
  // A country tag taken off the end of the release name.
  country: string | null;
}

// Words that say nothing about which title this is, so a title made only of them needs a year to match.
const fillerWords = new Set(["a", "all", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "go", "he", "her", "him", "his", "how", "i", "if", "in", "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "she", "so", "the", "to", "up", "us", "was", "we", "who", "why", "you"]);
const seasonToken = /^(?:s\d{1,4}(?:e\d{1,4})*|\d{1,2}x\d{1,4})$/;
// These only appear in release names, so the title has ended by the time one turns up.
const releaseToken = /^(?:\d{3,4}[pi]|[248]k|uhd|hdr\d*|webdl|webrip|hdtv|pdtv|dvdrip|bdrip|brrip|bluray|remux|x26[45]|h26[45]|hevc|xvid|divx|av1|10bit|8bit)$/;
// These also occur inside real titles ("Harriet's Web"), so they are only dropped from the end, as a second try.
const trailingReleaseWords = new Set(["web", "dl", "rip", "blu", "ray", "dvd", "hd", "extended", "unrated", "uncut", "remastered", "directors", "cut", "theatrical", "proper", "repack", "rerip", "internal", "limited", "complete", "multi", "dual", "imax", "hybrid"]);
const countryTags = new Set(["us", "uk", "au", "nz", "ca"]);
// What is left of a contraction when its apostrophe became a separator: Sam_s, Don.t, We_re.
const contractionEndings = new Set(["s", "t", "d", "m", "re", "ll", "ve"]);
// The shortest show title a season tag can vouch for, when it has no year to go on.
const minSeasonTitleLength = 3;
// A release can be dated a year apart from the library's title, usually around a new year's release.
const yearTolerance = 1;
const seasonFolder = /^(?:season|series|staffel|saison|temporada)[ ._-]*\d{1,4}$|^s\d{1,4}$|^specials?$|^(?:disc|disk|dvd|cd|part)[ ._-]*\d{1,2}$/i;

function tokenize(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Bracketed tags and ids are dropped, except a bracketed year.
    .replace(/[[{](?!\s*\d{4}\s*[\]}])[^\]}]*[\]}]/g, " ")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function plausibleYear(token: string, maxYear: number): number | null {
  if (!/^\d{4}$/.test(token)) return null;
  const year = Number(token);
  return year >= 1900 && year <= maxYear ? year : null;
}

// Initials written with dots, such as E.R. or S.W.A.T., which releases often spell as one word.
function withoutInitialDots(name: string): string {
  return name.replace(/(?<![\p{L}\p{N}])(?:\p{L}\.){2,}\p{L}?/gu, (initials) => initials.replace(/\./g, ""));
}

// Every spelling a release might use for this title. The first is the name as written.
function parseLibraryTitle(itemName: string, maxYear: number): { spellings: string[]; year: number | null; country: string | null } {
  const withoutIds = itemName.replace(/[[{][^\]}]*[\]}]/g, " ").trim();
  const countryTag = withoutIds.match(/\((us|uk|au|nz|ca)\)/i);
  const country = countryTag ? countryTag[1]!.toLowerCase() : null;
  const withoutCountry = countryTag ? withoutIds.replace(countryTag[0], " ").trim() : withoutIds;
  // Only a year in brackets counts here: "Orbit 1999" is the whole name, not "Orbit" from 1999.
  const dated = withoutCountry.match(/^(.*\S)\s*\((\d{4})\)\s*$/);
  const year = dated ? plausibleYear(dated[2]!, maxYear) : null;
  const base = year !== null ? dated![1]! : withoutCountry;
  const spellings = new Set<string>();
  for (const text of country ? [`${base} ${country}`, base] : [base]) {
    for (const form of [text, withoutInitialDots(text)]) {
      spellings.add(tokenize(form).join(" "));
      spellings.add(tokenize(form.replace(/&/g, " ")).join(" "));
    }
  }
  spellings.delete("");
  return { spellings: [...spellings], year, country };
}

export function buildTitleIndex(titles: Iterable<LibraryTitle>, now = new Date()): TitleIndex {
  const maxYear = now.getFullYear() + 1;
  const index: TitleIndex = new Map();
  for (const title of titles) {
    const { spellings, year, country } = parseLibraryTitle(title.itemName, maxYear);
    for (const [position, name] of spellings.entries()) {
      const entry = { ...title, year, country, isAlternate: position > 0 };
      const entries = index.get(name);
      if (entries) entries.push(entry);
      else index.set(name, [entry]);
    }
  }
  return index;
}

// The name with what looks like a split contraction put back together, or null when there is none to rejoin.
function rejoinContractions(tokens: string[]): string[] | null {
  const joined: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (index > 0 && contractionEndings.has(token) && !/\d$/.test(joined.at(-1)!)) joined[joined.length - 1] += token;
    else joined.push(token);
  }
  return joined.length < tokens.length ? joined : null;
}

function withCountryRemoved(name: string[], year: number | null): Candidate[] {
  const last = name.at(-1)!;
  return name.length > 1 && countryTags.has(last) ? [{ name: name.slice(0, -1).join(" "), year, country: last }] : [];
}

// The first token is always part of the title, so "1931" and "Season of Change" keep their names.
function parseRelease(tokens: string[], maxYear: number): { candidates: Candidate[]; isSeason: boolean } {
  let end = tokens.length;
  let isSeason = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const season = seasonToken.test(token) || (/^(?:season|series)$/.test(token) && /^\d{1,4}$/.test(tokens[index + 1] ?? ""));
    if (season) isSeason = true;
    if (index < end && (season || releaseToken.test(token))) end = index;
  }
  const run = tokens.slice(0, end);
  const candidates: Candidate[] = [];
  // A dated reading is tried first, latest year first, so "Walker 3 1992" and "Walker 2049 2017" keep their numbers.
  for (let index = run.length - 1; index >= 1; index -= 1) {
    const year = plausibleYear(run[index]!, maxYear);
    if (year === null) continue;
    candidates.push({ name: run.slice(0, index).join(" "), year, country: null }, ...withCountryRemoved(run.slice(0, index), year));
  }
  if (run.length > 0) candidates.push({ name: run.join(" "), year: null, country: null });
  let trimmed = run.length;
  while (trimmed > 1 && (trailingReleaseWords.has(run[trimmed - 1]!) || countryTags.has(run[trimmed - 1]!))) {
    const removed = withCountryRemoved(run.slice(0, trimmed), null);
    trimmed -= 1;
    candidates.push(removed[0] ?? { name: run.slice(0, trimmed).join(" "), year: null, country: null });
  }
  return { candidates, isSeason };
}

// One meaningful word is too little to go on: "On", "Lamp" and "The Lamp" could all turn up in unrelated release names.
function nameIsAmbiguous(name: string): boolean {
  return name.split(" ").filter((word) => !fillerWords.has(word)).length < 2;
}

function titleAccepts(entry: IndexedTitle, candidate: Candidate, isSeason: boolean): boolean {
  if (isSeason && entry.isShow === false) return false;
  // The release says which country's version it is, and this is another one.
  if (candidate.country && entry.country && candidate.country !== entry.country) return false;
  if (candidate.year !== null && entry.year !== null) return Math.abs(candidate.year - entry.year) <= yearTolerance;
  if (!nameIsAmbiguous(candidate.name)) return true;
  // A season tag and a shows section stand in for the year, as long as the word is not a tiny or filler one.
  return candidate.year === null && isSeason && entry.isShow === true && candidate.name.replace(/ /g, "").length >= minSeasonTitleLength && candidate.name.split(" ").some((word) => !fillerWords.has(word));
}

function bestFirst(accepted: IndexedTitle[], year: number | null): IndexedTitle[] {
  // A title from the release's own year rules out the ones from the year either side.
  const sameYear = year === null ? [] : accepted.filter((title) => title.year === year);
  const titles = sameYear.length > 0 ? sameYear : accepted;
  // The name as written wins over another spelling of it: "Show (2001)" before "Show (US) (2005)" for a plain "Show".
  return [...titles].sort((left, right) => Number(left.isAlternate) - Number(right.isAlternate));
}

/**
 * Every library title this release name appears to be, best first. Titles can share a name, and with no year to
 * tell them apart they all count. Names are compared whole, never by a part of one, and this can still be wrong.
 */
export function matchReleaseTitles(index: TitleIndex, releaseName: string, now = new Date()): IndexedTitle[] {
  const maxYear = now.getFullYear() + 1;
  const tokens = tokenize(releaseName);
  const rejoined = rejoinContractions(tokens);
  for (const spelling of rejoined ? [tokens, rejoined] : [tokens]) {
    const { candidates, isSeason } = parseRelease(spelling, maxYear);
    for (const candidate of candidates) {
      const accepted = index.get(candidate.name)?.filter((title) => titleAccepts(title, candidate, isSeason));
      if (accepted?.length) return bestFirst(accepted, candidate.year);
    }
  }
  return [];
}

/** The best library title for this release name, or null. */
export function matchReleaseTitle(index: TitleIndex, releaseName: string, now = new Date()): string | null {
  return matchReleaseTitles(index, releaseName, now)[0]?.itemName ?? null;
}

/**
 * The folder a file arrived in, relative to its storage root, or the file itself when it has no folder of its own.
 * Season and disc folders belong to the release above them. `containers` are top-level folders that hold many releases.
 */
export function releaseKeyOf(relativePath: string, containers: ReadonlySet<string> = new Set()): string {
  const parts = relativePath.split("/");
  let end = parts.length - 1;
  while (end > 1 && seasonFolder.test(parts[end - 1]!)) end -= 1;
  if (end === 0) return relativePath;
  if (end === 1 && (containers.has(parts[0]!) || /^__.*__$/.test(parts[0]!))) return relativePath;
  return parts.slice(0, end).join("/");
}

/** The name to compare with library titles: the release folder, or the file name without its extension for a lone file. */
export function releaseNameOf(releaseKey: string, relativePath: string): string {
  if (releaseKey !== relativePath) return path.posix.basename(releaseKey);
  const base = path.posix.basename(relativePath);
  const extension = path.posix.extname(base);
  return extension ? base.slice(0, -extension.length) : base;
}
