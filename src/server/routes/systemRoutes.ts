import type { FastifyInstance } from "fastify";
import packageJson from "../../../package.json";
import type { AppReleaseChannel, AppReleaseInfo, AppVersionInfo, AppVersionStatus } from "../../shared/types";

const githubReleasesUrl = "https://api.github.com/repos/ramphex/srtl-manager/releases?per_page=20";
const githubReleaseCheckIntervalMs = 24 * 60 * 60 * 1000;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

interface GithubRelease {
  tagName: string;
  url: string | null;
  notes: string | null;
  prerelease: boolean;
}

interface GithubReleaseCheck {
  releases: GithubRelease[];
  unavailableMessage?: string;
  checkedAt: string;
}

let githubReleaseCache: { value: GithubReleaseCheck; expiresAtMs: number } | null = null;
let githubReleaseCheckInFlight: Promise<GithubReleaseCheck> | null = null;

function parseVersion(value: string | null): ParsedVersion | null {
  if (!value) return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".").filter(Boolean) ?? []
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    const difference = leftPart.localeCompare(rightPart);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compareVersions(leftRaw: string | null, rightRaw: string | null): number {
  const left = parseVersion(leftRaw);
  const right = parseVersion(rightRaw);
  if (!left || !right) return 0;
  const coreDifference = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (coreDifference !== 0) return coreDifference;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function isNewerVersion(latest: string | null, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function normalizeVersion(value: string | null): string | null {
  return value?.replace(/^v/, "") ?? null;
}

function currentReleaseChannel(currentVersion: string): AppReleaseChannel {
  const parsed = parseVersion(currentVersion);
  return parsed?.prerelease.some((part) => part.toLowerCase().includes("beta")) ? "beta" : "stable";
}

function channelLabel(channel: AppReleaseChannel): string {
  return channel === "beta" ? "Beta" : "Stable";
}

function overallStatus(stable: AppReleaseInfo, beta: AppReleaseInfo): AppVersionStatus {
  if (stable.updateAvailable || beta.updateAvailable) return "update_available";
  if (stable.status === "unavailable" && beta.status === "unavailable") return "unavailable";
  return "up_to_date";
}

function readRefreshQuery(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  const refresh = (query as Record<string, unknown>).refresh;
  return refresh === true || refresh === "true" || refresh === "1";
}

function readStringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object" || !(field in value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function readBooleanField(value: unknown, field: string): boolean {
  if (!value || typeof value !== "object" || !(field in value)) return false;
  return (value as Record<string, unknown>)[field] === true;
}

function trimReleaseNotes(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 4000) : null;
}

function readRelease(value: unknown): GithubRelease | null {
  if (!value || typeof value !== "object" || readBooleanField(value, "draft")) return null;
  const tagName = readStringField(value, "tag_name");
  if (!tagName || !parseVersion(tagName)) return null;
  return {
    tagName,
    url: readStringField(value, "html_url"),
    notes: trimReleaseNotes(readStringField(value, "body")),
    prerelease: readBooleanField(value, "prerelease")
  };
}

function latestReleaseForChannel(releases: GithubRelease[], channel: AppReleaseChannel): GithubRelease | null {
  const prerelease = channel === "beta";
  return releases
    .filter((release) => release.prerelease === prerelease)
    .sort((left, right) => compareVersions(right.tagName, left.tagName))[0] ?? null;
}

function releaseInfoForChannel(channel: AppReleaseChannel, latest: GithubRelease | null, currentVersion: string, unavailableMessage?: string): AppReleaseInfo {
  if (!latest) {
    return {
      channel,
      latestVersion: null,
      updateAvailable: false,
      status: "unavailable",
      releaseUrl: null,
      releaseNotes: null,
      message: unavailableMessage ?? `No ${channelLabel(channel).toLowerCase()} releases yet`
    };
  }
  const updateAvailable = isNewerVersion(latest.tagName, currentVersion);
  return {
    channel,
    latestVersion: normalizeVersion(latest.tagName),
    updateAvailable,
    status: updateAvailable ? "update_available" : "up_to_date",
    releaseUrl: latest.url,
    releaseNotes: latest.notes,
    message: updateAvailable ? `${channelLabel(channel)} ${latest.tagName} available` : `${channelLabel(channel)} is up to date`
  };
}

function cacheReleaseCheck(value: GithubReleaseCheck): GithubReleaseCheck {
  githubReleaseCache = { value, expiresAtMs: Date.now() + githubReleaseCheckIntervalMs };
  return value;
}

function unavailableReleaseCheck(message: string): GithubReleaseCheck {
  return {
    releases: [],
    unavailableMessage: message,
    checkedAt: new Date().toISOString()
  };
}

async function fetchReleases(): Promise<GithubReleaseCheck> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const response = await fetch(githubReleasesUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "srtl-manager-version-check"
    },
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  if (response.status === 404) {
    return { releases: [], unavailableMessage: "No GitHub releases yet", checkedAt };
  }
  if (!response.ok) {
    return { releases: [], unavailableMessage: "GitHub release check unavailable", checkedAt };
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(payload)) return { releases: [], unavailableMessage: "GitHub release check unavailable", checkedAt };
  const releases = payload.map(readRelease).filter((release): release is GithubRelease => release != null);
  return releases.length > 0 ? { releases, checkedAt } : { releases, unavailableMessage: "No GitHub releases yet", checkedAt };
}

async function readReleaseCheck(forceRefresh: boolean): Promise<GithubReleaseCheck> {
  if (!forceRefresh && githubReleaseCache && githubReleaseCache.expiresAtMs > Date.now()) {
    return githubReleaseCache.value;
  }

  if (!forceRefresh && githubReleaseCheckInFlight) {
    return githubReleaseCheckInFlight;
  }

  const request = fetchReleases().then(cacheReleaseCheck);
  if (!forceRefresh) githubReleaseCheckInFlight = request;

  try {
    return await request;
  } finally {
    if (!forceRefresh) githubReleaseCheckInFlight = null;
  }
}

function appVersionInfo(currentVersion: string, github: GithubReleaseCheck): AppVersionInfo {
  const currentChannel = currentReleaseChannel(currentVersion);
  const stable = releaseInfoForChannel("stable", latestReleaseForChannel(github.releases, "stable"), currentVersion, github.unavailableMessage);
  const beta = releaseInfoForChannel("beta", latestReleaseForChannel(github.releases, "beta"), currentVersion, github.unavailableMessage);
  const status = overallStatus(stable, beta);
  const currentChannelInfo = currentChannel === "beta" ? beta : stable;
  const updateMessages = [stable, beta].filter((release) => release.updateAvailable).map((release) => release.message);

  return {
    currentVersion,
    currentChannel,
    currentChannelLabel: channelLabel(currentChannel),
    stable,
    beta,
    latestVersion: currentChannelInfo.latestVersion,
    updateAvailable: stable.updateAvailable || beta.updateAvailable,
    status,
    releaseUrl: currentChannelInfo.releaseUrl,
    checkedAt: github.checkedAt,
    message: updateMessages.length > 0 ? updateMessages.join("; ") : status === "unavailable" ? (github.unavailableMessage ?? "GitHub release check unavailable") : "Version is up to date"
  };
}

function shouldWarmReleaseCheck(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.VITEST !== "true";
}

function warmReleaseCheck(app: FastifyInstance): void {
  if (!shouldWarmReleaseCheck()) return;

  void readReleaseCheck(false)
    .then((github) => {
      app.log.info({ checkedAt: github.checkedAt }, "GitHub release check cached");
    })
    .catch((error) => {
      app.log.warn({ err: error }, "GitHub release check failed during startup");
      cacheReleaseCheck(unavailableReleaseCheck("GitHub release check unavailable"));
    });
}

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get("/api/system/version", async (request): Promise<AppVersionInfo> => {
    const currentVersion = packageJson.version;
    const forceRefresh = readRefreshQuery(request.query);

    try {
      return appVersionInfo(currentVersion, await readReleaseCheck(forceRefresh));
    } catch (error) {
      app.log.warn({ err: error }, "GitHub release check failed");
      return appVersionInfo(currentVersion, cacheReleaseCheck(unavailableReleaseCheck("GitHub release check unavailable")));
    }
  });

  warmReleaseCheck(app);
}
