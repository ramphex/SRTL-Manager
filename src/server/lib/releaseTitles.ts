import path from "node:path";

export interface LibraryTitle {
  itemName: string;
  // True for a shows section, false for a movies section, null when the section could hold either.
  isShow: boolean | null;
}

interface IndexedTitle extends LibraryTitle {
  year: number | null;
}

export type TitleIndex = Map<string, IndexedTitle[]>;

interface Candidate {
  name: string;
  year: number | null;
}

// Words that say nothing about which title this is, so a title made only of them needs a year to match.
const fillerWords = new Set(["a", "an", "and", "at", "by", "for", "from", "he", "her", "him", "his", "i", "in", "is", "it", "me", "my", "of", "on", "or", "she", "the", "to", "up", "us", "we", "you"]);
const seasonToken = /^(?:s\d{1,4}(?:e\d{1,4})*|\d{1,2}x\d{1,4})$/;
// These only appear in release names, so the title has ended by the time one turns up.
const releaseToken = /^(?:\d{3,4}[pi]|[248]k|uhd|hdr\d*|webdl|webrip|hdtv|pdtv|dvdrip|bdrip|brrip|bluray|remux|x26[45]|h26[45]|hevc|xvid|divx|av1|10bit|8bit)$/;
// These also occur inside real titles ("Harriet's Web"), so they are only dropped from the end, as a second try.
const trailingReleaseWords = new Set(["web", "dl", "rip", "blu", "ray", "dvd", "hd", "extended", "unrated", "uncut", "remastered", "directors", "cut", "theatrical", "proper", "repack", "rerip", "internal", "limited", "complete", "multi", "dual", "imax", "hybrid", "us", "uk", "au", "nz", "ca"]);
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

function parseLibraryTitle(itemName: string, maxYear: number): Candidate {
  // Only a year in brackets counts here: "Orbit 1999" is the whole name, not "Orbit" from 1999.
  const withoutIds = itemName.replace(/[[{][^\]}]*[\]}]/g, " ").trim();
  const dated = withoutIds.match(/^(.*\S)\s*\((\d{4})\)\s*$/);
  const year = dated ? plausibleYear(dated[2]!, maxYear) : null;
  return { name: tokenize(year !== null ? dated![1]! : withoutIds).join(" "), year };
}

export function buildTitleIndex(titles: Iterable<LibraryTitle>, now = new Date()): TitleIndex {
  const maxYear = now.getFullYear() + 1;
  const index: TitleIndex = new Map();
  for (const title of titles) {
    const { name, year } = parseLibraryTitle(title.itemName, maxYear);
    if (!name) continue;
    const entries = index.get(name);
    if (entries) entries.push({ ...title, year });
    else index.set(name, [{ ...title, year }]);
  }
  return index;
}

// The first token is always part of the title, so "1931" and "Season of Change" keep their names.
function parseRelease(releaseName: string, maxYear: number): { candidates: Candidate[]; isSeason: boolean } {
  const tokens = tokenize(releaseName);
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
    if (year !== null) candidates.push({ name: run.slice(0, index).join(" "), year });
  }
  candidates.push({ name: run.join(" "), year: null });
  let trimmed = run.length;
  while (trimmed > 1 && trailingReleaseWords.has(run[trimmed - 1]!)) {
    trimmed -= 1;
    candidates.push({ name: run.slice(0, trimmed).join(" "), year: null });
  }
  return { candidates, isSeason };
}

// One meaningful word is too little to go on: "On", "Lamp" and "The Lamp" could all turn up in unrelated release names.
function nameIsAmbiguous(name: string): boolean {
  return name.split(" ").filter((word) => !fillerWords.has(word)).length < 2;
}

function titleAccepts(entry: IndexedTitle, candidate: Candidate, isSeason: boolean): boolean {
  if (isSeason && entry.isShow === false) return false;
  if (candidate.year !== null && entry.year !== null) return Math.abs(candidate.year - entry.year) <= yearTolerance;
  if (!nameIsAmbiguous(candidate.name)) return true;
  // A season tag and a shows section stand in for the year, as long as the word is not a tiny one.
  return candidate.year === null && isSeason && entry.isShow === true && candidate.name.replace(/ /g, "").length >= 4 && candidate.name.split(" ").some((word) => !fillerWords.has(word));
}

/** The library title this release name appears to be, compared by whole name and never by a part of one. This is a name comparison and can be wrong. */
export function matchReleaseTitle(index: TitleIndex, releaseName: string, now = new Date()): string | null {
  const { candidates, isSeason } = parseRelease(releaseName, now.getFullYear() + 1);
  for (const candidate of candidates) {
    const entry = index.get(candidate.name)?.find((title) => titleAccepts(title, candidate, isSeason));
    if (entry) return entry.itemName;
  }
  return null;
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
