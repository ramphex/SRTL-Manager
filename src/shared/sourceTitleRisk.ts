export type SourceTitleRiskSeverity = "ok" | "warn" | "block";

export interface SourceTitleRiskResult {
  severity: SourceTitleRiskSeverity;
  reason: string;
  expectedTitle: string;
  sourceName: string;
  sourceParent: string | null;
  score: number;
  expectedTokens: string[];
  sourceTokens: string[];
  matchedTokens: string[];
  expectedYear: string | null;
  sourceYears: string[];
  yearMatched: boolean;
  yearMismatch: boolean;
}

const releaseNoiseTokens = new Set([
  "aac",
  "ac3",
  "amzn",
  "atmos",
  "av1",
  "avc",
  "bdremux",
  "bluray",
  "brrip",
  "core",
  "dd",
  "ddp",
  "dl",
  "dts",
  "dv",
  "dvd",
  "dvdrip",
  "eac3",
  "extended",
  "h264",
  "h265",
  "hdlight",
  "hdr",
  "hevc",
  "hulu",
  "multi",
  "nf",
  "proper",
  "repack",
  "remux",
  "sdr",
  "truehd",
  "uhd",
  "uncut",
  "vfi",
  "web",
  "webdl",
  "webrip",
  "x264",
  "x265"
]);

const titleStopwordTokens = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "with"]);

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeInitials(text: string): string {
  let current = text;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = current.replace(/\b([A-Za-z])\.\s*([A-Za-z])\./g, "$1$2");
    if (next === current) return current;
    current = next;
  }
  return current;
}

function normalizeText(text: string): string {
  return normalizeInitials(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([A-Za-z])\$([A-Za-z])/g, "$1s$2")
    .replace(/\{(?:imdb|tmdb|tvdb)-[^}]+\}/gi, " ")
    .replace(/&/g, " and ")
    .replace(/[._+]+/g, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function splitPath(sourcePath: string): string[] {
  return sourcePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{2,6}$/, "");
}

function extractYears(text: string): string[] {
  return unique(Array.from(text.matchAll(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)/g)).map((match) => match[1]).filter((year): year is string => Boolean(year)));
}

function isReleaseNoiseToken(token: string): boolean {
  return (
    releaseNoiseTokens.has(token) ||
    /^(?:19|20)[0-9]{2}$/.test(token) ||
    /^[0-9]{3,4}p$/.test(token) ||
    /^s[0-9]{1,2}e[0-9]{1,3}$/.test(token) ||
    /^e[0-9]{1,3}$/.test(token) ||
    /^v[0-9]+$/.test(token) ||
    /^tmdb[0-9]*$/.test(token) ||
    /^imdb[0-9]*$/.test(token) ||
    /^tt[0-9]+$/.test(token)
  );
}

function rawTokens(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

function titleTokens(text: string): string[] {
  const tokens = rawTokens(text).filter((token) => !isReleaseNoiseToken(token));
  const withoutStopwords = tokens.filter((token) => !titleStopwordTokens.has(token));
  return unique(withoutStopwords.length > 0 ? withoutStopwords : tokens);
}

function sourceCandidates(sourcePath: string): { sourceName: string; sourceParent: string | null; texts: string[] } {
  const parts = splitPath(sourcePath);
  const sourceName = stripExtension(parts.at(-1) ?? sourcePath);
  const sourceParent = parts.length > 1 ? parts.at(-2) ?? null : null;
  const nearbyParents = parts.slice(0, -1).slice(-4);
  return {
    sourceName,
    sourceParent,
    texts: unique([sourceName, ...nearbyParents, [...nearbyParents, sourceName].join(" ")].filter(Boolean))
  };
}

function compactTokens(tokens: string[]): string {
  return tokens.join("");
}

function scoreCandidate(expectedTokens: string[], candidateText: string): { matchedTokens: string[]; sourceTokens: string[]; score: number } {
  const sourceTokens = titleTokens(candidateText);
  const sourceTokenSet = new Set(sourceTokens);
  const matchedTokens = expectedTokens.filter((token) => sourceTokenSet.has(token));
  const expectedCompact = compactTokens(expectedTokens);
  const sourceCompact = compactTokens(sourceTokens);
  const compactMatched = expectedCompact.length > 2 && sourceCompact.includes(expectedCompact);
  const score = compactMatched ? 100 : Math.round((matchedTokens.length / expectedTokens.length) * 100);

  return {
    matchedTokens: compactMatched ? expectedTokens : matchedTokens,
    sourceTokens,
    score
  };
}

export function evaluateSourceTitleRisk(input: { expectedTitle: string; sourcePath: string }): SourceTitleRiskResult {
  const expectedTitle = input.expectedTitle.trim();
  const sourcePath = input.sourcePath.trim();
  const expectedTokens = titleTokens(expectedTitle);
  const expectedYear = extractYears(expectedTitle)[0] ?? null;
  const { sourceName, sourceParent, texts } = sourceCandidates(sourcePath);
  const sourceYears = unique(texts.flatMap(extractYears));
  const yearMatched = Boolean(expectedYear && sourceYears.includes(expectedYear));
  const yearMismatch = Boolean(expectedYear && sourceYears.length > 0 && !sourceYears.includes(expectedYear));

  if (!expectedTitle || !sourcePath || expectedTokens.length === 0) {
    return {
      severity: "warn",
      reason: "Source title could not be checked",
      expectedTitle,
      sourceName,
      sourceParent,
      score: 0,
      expectedTokens,
      sourceTokens: [],
      matchedTokens: [],
      expectedYear,
      sourceYears,
      yearMatched,
      yearMismatch
    };
  }

  const best = texts
    .map((text) => scoreCandidate(expectedTokens, text))
    .sort((first, second) => second.score - first.score || second.matchedTokens.length - first.matchedTokens.length)[0] ?? {
    matchedTokens: [],
    sourceTokens: [],
    score: 0
  };

  let severity: SourceTitleRiskSeverity;
  let reason: string;

  if (best.score >= 75) {
    severity = yearMismatch ? "warn" : "ok";
    reason = yearMismatch ? "Source title matches, but the year differs" : "Source name appears to match expected title";
  } else if (best.score >= 50) {
    severity = "warn";
    reason = "Only some expected title words appear in the source name";
  } else {
    severity = "block";
    reason = "Source name does not match expected title";
  }

  return {
    severity,
    reason,
    expectedTitle,
    sourceName,
    sourceParent,
    score: best.score,
    expectedTokens,
    sourceTokens: best.sourceTokens,
    matchedTokens: best.matchedTokens,
    expectedYear,
    sourceYears,
    yearMatched,
    yearMismatch
  };
}
