import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { nowIso } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { plexEndpoints, xmlElements } from "../src/server/lib/plexClient";
import {
  addWatchSyncServer,
  approveWatchSyncPair,
  checkPlexSignIn,
  createWatchSyncPair,
  discoverWatchSyncUsers,
  exportWatchSyncBackup,
  getWatchSyncState,
  listWatchSyncActivity,
  saveWatchSyncSettings,
  setWatchSyncPaused,
  startPlexSignIn,
  suggestPairs,
  updateWatchSyncPair,
  watchSyncNameKeys,
  writeCursor
} from "../src/server/lib/watchSync";
import { decideWatchSync, runWatchSyncJob, runWatchSyncTick, scheduleWatchSyncReconcile, toSrtlPath, watchSyncPacing, type WatchSyncJobOptions } from "../src/server/lib/watchSyncEngine";
import { watchSyncHttpTiming } from "../src/server/lib/watchSyncHttp";
import type { WatchSyncDirection, WatchSyncSideState, WatchSyncState } from "../src/shared/watchSync";
import { MockMediaServers, type MockItem } from "./watchSyncMocks";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let mock: MockMediaServers;
let events: string[];

const srtlRoot = "/mnt/plex";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function item(plexKey: string, jellyfinId: string, title: string, type: "movie" | "episode" = "movie", srtl = true): MockItem {
  const relative = type === "movie" ? `movies/${title} (2020)/${title}.mkv` : `tv/Show/Season 01/${title}.mkv`;
  return {
    plexKey, jellyfinId, type, title,
    plexFile: srtl ? `/data/media/${relative}` : `/data/home-videos/${title}.mkv`,
    jellyfinPath: srtl ? `${srtlRoot}/${relative}` : `/home-videos/${title}.mkv`,
    addedAt: Math.floor(minutesAgo(60 * 24 * 30).getTime() / 1000)
  };
}

const alpha = item("11", "a1", "Alpha");
const beta = item("12", "b2", "Beta");
const gamma = item("13", "c3", "Gamma");
const episode = item("21", "e1", "Pilot", "episode");
const homeVideo = item("99", "z9", "Birthday", "movie", false);

async function seedLinks(items: MockItem[]): Promise<void> {
  const timestamp = nowIso();
  for (const entry of items.filter((candidate) => candidate.jellyfinPath.startsWith(srtlRoot))) {
    const relativePath = entry.jellyfinPath.slice(srtlRoot.length + 1);
    const [section, itemName] = relativePath.split("/");
    await app.database.db.insert(schema.mediaLinks).values({
      section: section!, itemName: itemName!, relativePath, linkPath: entry.jellyfinPath, targetPath: `/remote/${relativePath}`, kind: "remote",
      targetExists: true, isMedia: true, updatedAt: timestamp
    });
  }
}

function controls(jobId = 0) {
  return { jobId, signal: new AbortController().signal, event: async (_level: string, message: string) => { events.push(message); }, setProgress: async () => undefined };
}

async function job(options: WatchSyncJobOptions) {
  return runWatchSyncJob(app.database.db, options, controls());
}

async function state(): Promise<WatchSyncState> {
  return getWatchSyncState(app.database.db);
}

async function signInPlex(): Promise<string> {
  const db = app.database.db;
  await addWatchSyncServer(db, "plex", { name: "Home Plex", url: `${mock.base}/pms`, prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: srtlRoot }] });
  const plexId = (await state()).settings.servers.find((server) => server.kind === "plex")!.id;
  const pin = await startPlexSignIn(db, plexId);
  expect(pin.authUrl).toContain("code=WXYZ");
  expect((await checkPlexSignIn(db, plexId, pin.pinId)).status).toBe("waiting");
  expect((await checkPlexSignIn(db, plexId, pin.pinId)).status).toBe("authorized");
  return plexId;
}

async function addJellyfin(name: string): Promise<string> {
  const db = app.database.db;
  await addWatchSyncServer(db, "jellyfin", { name, url: `${mock.base}/${name}`, token: mock.jellyfin.get(name)!.apiKey, prefixMappings: [] });
  const id = (await state()).settings.servers.find((server) => server.name === name)!.id;
  await discoverWatchSyncUsers(db, id);
  return id;
}

// Signs in, pairs the owner with the Jellyfin user, previews, and approves with a first full sync.
async function connectedPair(direction: WatchSyncDirection = "both", jellyfin = "jf1", jellyfinUser = "jf-alex"): Promise<{ pairId: number; plexId: string; jellyfinId: string }> {
  const existing = (await state()).settings.servers;
  const plexId = existing.find((server) => server.kind === "plex")?.id ?? await signInPlex();
  const jellyfinId = existing.find((server) => server.name === jellyfin)?.id ?? await addJellyfin(jellyfin);
  await createWatchSyncPair(app.database.db, { plexServerId: plexId, plexUserId: "100", jellyfinServerId: jellyfinId, jellyfinUserId: jellyfinUser, direction });
  const pairId = (await state()).pairs.find((pair) => pair.jellyfinServerId === jellyfinId && pair.jellyfinUserId === jellyfinUser)!.id;
  await job({ mode: "preview", pairIds: [pairId] });
  await approveWatchSyncPair(app.database.db, pairId);
  await job({ mode: "reconcile", pairIds: [pairId] });
  return { pairId, plexId, jellyfinId };
}

async function makeDue(): Promise<void> {
  await app.database.db.update(schema.watchSyncPairs).set({ lastSyncAt: minutesAgo(60).toISOString() });
}

async function tick() {
  await makeDue();
  return runWatchSyncTick(app.database.db);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-watch-sync-test-"));
  for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  mock = new MockMediaServers();
  await mock.start();
  mock.items = [alpha, beta, gamma, episode, homeVideo];
  mock.addJellyfin("jf1", { users: [{ id: "jf-alex", name: "Alex" }, { id: "jf-bob", name: "friendbob" }, { id: "jf-off", name: "Old", disabled: true }] });
  await seedLinks(mock.items);
  plexEndpoints.plexTv = `${mock.base}/plextv`;
  plexEndpoints.plexApp = "https://app.plex.invalid";
  watchSyncHttpTiming.backoffMs = 1;
  watchSyncPacing.pageDelayMs = 0;
  events = [];
});

afterEach(async () => {
  await mock.stop();
  await app.app.close();
  await database.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("watch sync decisions", () => {
  const features = { watched: true, position: true };
  const unwatched: WatchSyncSideState = { watched: false, positionMs: 0, at: null };
  const watched = (at: string | null = null): WatchSyncSideState => ({ watched: true, positionMs: 0, at });

  it("adds history on a first sync but never removes it", () => {
    expect(decideWatchSync("both", features, watched(), unwatched, null).write).toMatchObject({ target: "jellyfin", action: "watched" });
    expect(decideWatchSync("plex_to_jellyfin", features, unwatched, watched(), null).write).toBeNull();
    expect(decideWatchSync("both", features, unwatched, unwatched, null)).toEqual({ write: null, snapshot: null });
  });

  it("keeps one-way pairs one way and acknowledges changes on the receiving side", () => {
    const snapshot = { plex: unwatched, jellyfin: unwatched };
    expect(decideWatchSync("jellyfin_to_plex", features, watched(), unwatched, snapshot)).toEqual({ write: null, snapshot: { plex: watched(), jellyfin: unwatched } });
    expect(decideWatchSync("jellyfin_to_plex", features, unwatched, watched(), snapshot).write).toMatchObject({ target: "plex", action: "watched" });
  });

  it("lets the most recent change win when both sides changed", () => {
    const snapshot = { plex: unwatched, jellyfin: unwatched };
    const plexResume = { watched: false, positionMs: 600_000, at: minutesAgo(10).toISOString() };
    expect(decideWatchSync("both", features, plexResume, watched(minutesAgo(1).toISOString()), snapshot).write).toMatchObject({ target: "plex", action: "watched" });
    expect(decideWatchSync("both", features, { ...plexResume, at: minutesAgo(1).toISOString() }, { watched: false, positionMs: 60_000, at: minutesAgo(5).toISOString() }, snapshot).write)
      .toMatchObject({ target: "jellyfin", action: "position", desired: { positionMs: 600_000 } });
  });

  it("respects the watched and resume position toggles", () => {
    const snapshot = { plex: unwatched, jellyfin: unwatched };
    const resume = { watched: false, positionMs: 900_000, at: null };
    expect(decideWatchSync("both", { watched: true, position: false }, resume, unwatched, snapshot).write).toBeNull();
    expect(decideWatchSync("both", { watched: false, position: true }, watched(), unwatched, snapshot).write).toBeNull();
    expect(decideWatchSync("both", { watched: false, position: true }, resume, unwatched, snapshot).write).toMatchObject({ action: "position" });
  });

  it("maps server paths with the longest matching prefix", () => {
    const mappings = [{ serverPrefix: "/data", srtlPrefix: "/srv" }, { serverPrefix: "/data/media", srtlPrefix: "/mnt/plex" }];
    expect(toSrtlPath("/data/media/movies/A/A.mkv", mappings)).toBe("/mnt/plex/movies/A/A.mkv");
    expect(toSrtlPath("/data/other/A.mkv", mappings)).toBe("/srv/other/A.mkv");
    expect(toSrtlPath("/data/mediaextra/A.mkv", mappings)).toBe("/srv/mediaextra/A.mkv");
    expect(toSrtlPath("/mnt/plex/tv/x.mkv", mappings)).toBe("/mnt/plex/tv/x.mkv");
  });
});

describe("watch sync user pairing", () => {
  it("suggests pairs ignoring case, punctuation, and trailing digits", () => {
    expect(watchSyncNameKeys("alex_03")).toEqual({ exact: "alex03", letters: "alex" });
    const plexUsers = [
      { serverId: "p", externalId: "1", name: "alex_03", username: "alex_03" },
      { serverId: "p", externalId: "2", name: "Friend.Bob", username: "friendbob" },
      { serverId: "p", externalId: "3", name: "Sam", username: "sam" },
      { serverId: "p", externalId: "4", name: "Kids", username: null }
    ];
    const jellyfinUsers = [
      { serverId: "j", externalId: "a", name: "Alex" },
      { serverId: "j", externalId: "b", name: "FriendBob" },
      { serverId: "j", externalId: "c", name: "Sam1" },
      { serverId: "j", externalId: "d", name: "sam_2" }
    ];
    const suggestions = suggestPairs(plexUsers, jellyfinUsers, [{ plexServerId: "p", plexUserId: "4", jellyfinServerId: "j", jellyfinUserId: "x" }]);
    expect(suggestions.map((entry) => [entry.plexUserName, entry.jellyfinUserName, entry.match])).toEqual([
      ["alex_03", "Alex", "similar"],
      ["Friend.Bob", "FriendBob", "exact"]
    ]);
  });

  it("signs in with a Plex PIN and finds the owner, Home, managed, and friend users with their own tokens", async () => {
    const plexId = await signInPlex();
    const current = await state();
    const users = current.users.filter((user) => user.serverId === plexId);
    expect(users.map((user) => [user.name, user.kind, user.ready]).sort()).toEqual([
      ["Friend.Bob", "friend", true],
      ["Kids & Co", "managed", true],
      ["NoShare", "friend", false],
      ["Partner", "home", true],
      ["alex_03", "owner", true]
    ]);
    expect(users.find((user) => user.name === "NoShare")?.note).toContain("Share at least one library");
    expect(current.settings.servers[0]).toMatchObject({ hasToken: true, machineIdentifier: "machine-1", accountName: "alex_03", lastError: null });
    // Tokens are stored for each user but never sent to the browser.
    expect(JSON.stringify(current)).not.toContain("tok-bob");
    expect(JSON.stringify(current)).not.toContain(mock.ownerToken);
    const stored = await app.database.db.select().from(schema.watchSyncUsers).where(eq(schema.watchSyncUsers.externalId, "300"));
    expect(stored[0]?.accessToken).toBe("tok-kids");
    expect(mock.pinPolls).toBe(2);
  });

  it("reads plex.tv XML with escaped attributes", () => {
    expect(xmlElements(`<A><User id="1" title="Tom &amp; &quot;Jerry&quot;"><Server machineIdentifier="m"/></User><User id="2"/></A>`, "User").map((entry) => entry.attributes)).toEqual([
      { id: "1", title: "Tom & \"Jerry\"" },
      { id: "2" }
    ]);
  });

  it("suggests the owner and a friend for the Jellyfin users once both servers are connected", async () => {
    await signInPlex();
    await addJellyfin("jf1");
    const suggestions = (await state()).suggestions.map((entry) => `${entry.plexUserName}->${entry.jellyfinUserName}`);
    expect(suggestions).toEqual(expect.arrayContaining(["alex_03->Alex", "Friend.Bob->friendbob"]));
    expect(suggestions.some((entry) => entry.endsWith("->Old"))).toBe(false);
  });
});

describe("watch sync", () => {
  it("writes nothing before the preview is approved, and the preview counts each direction", async () => {
    const plexId = await signInPlex();
    const jellyfinId = await addJellyfin("jf1");
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true, at: minutesAgo(30) });
    mock.setJellyfin("jf1", "jf-alex", beta.jellyfinId, { watched: true, at: minutesAgo(20) });
    mock.setJellyfin("jf1", "jf-alex", episode.jellyfinId, { offsetMs: 1_200_000, at: minutesAgo(10) });
    await createWatchSyncPair(app.database.db, { plexServerId: plexId, plexUserId: "100", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-alex" });
    const pairId = (await state()).pairs[0]!.id;
    await expect(approveWatchSyncPair(app.database.db, pairId)).rejects.toThrow("Run a preview");

    // Unapproved pairs are invisible to the timer and to scheduled reconciliation.
    expect(await tick()).toEqual({ synced: 0, failed: 0, written: 0 });
    expect(await scheduleWatchSyncReconcile(app.database.db, async () => 1)).toBeNull();

    await job({ mode: "preview", pairIds: [pairId] });
    const preview = (await state()).pairs[0]!.preview!;
    expect(preview.counts).toEqual({ plex_to_jellyfin: { watched: 1, unwatched: 0, position: 0 }, jellyfin_to_plex: { watched: 1, unwatched: 0, position: 1 } });
    expect(preview).toMatchObject({ plexItems: 5, jellyfinItems: 5, matched: 4, skipped: 2 });
    expect(preview.samples.map((sample) => sample.title).sort()).toEqual(["Alpha", "Beta", "Show S01E01 - Pilot"]);
    expect(mock.writes).toEqual([]);
    // A reconcile job for an unapproved pair writes nothing either.
    await job({ mode: "reconcile", pairIds: [pairId] });
    expect(mock.writes).toEqual([]);

    await approveWatchSyncPair(app.database.db, pairId);
    await job({ mode: "reconcile", pairIds: [pairId] });
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`).sort()).toEqual(["jf1:played:a1", "plex:progress:21", "plex:scrobble:12"]);
    expect(mock.jellyfinState("jf1", "jf-alex", alpha.jellyfinId).watched).toBe(true);
    expect(mock.plexState(mock.ownerToken, episode.plexKey).offsetMs).toBe(1_200_000);
    // The original play time travels with the watch.
    expect(mock.writes.find((write) => write.item === "a1")?.value).toBe(new Date(Math.floor(minutesAgo(30).getTime() / 1000) * 1000).toISOString());
    const pair = (await state()).pairs[0]!;
    expect(pair).toMatchObject({ lastError: null, trackedItems: 3 });
    expect(pair.lastFullSyncAt).not.toBeNull();
    expect((await listWatchSyncActivity(app.database.db, pairId)).some((entry) => entry.message.includes(`Marked "Alpha" watched on Jellyfin (from Plex)`))).toBe(true);
  });

  it("syncs Plex to Jellyfin only", async () => {
    const { pairId } = await connectedPair("plex_to_jellyfin");
    mock.writes = [];
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true });
    mock.setJellyfin("jf1", "jf-alex", beta.jellyfinId, { watched: true });
    expect(await tick()).toMatchObject({ synced: 1, failed: 0 });
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`)).toEqual(["jf1:played:a1"]);
    expect(mock.plexState(mock.ownerToken, beta.plexKey).watched).toBe(false);
    // The Jellyfin-only change was acknowledged and is not reconsidered.
    await tick();
    expect(mock.writes).toHaveLength(1);
    expect((await state()).pairs.find((pair) => pair.id === pairId)?.lastError).toBeNull();
  });

  it("syncs Jellyfin to Plex only", async () => {
    await connectedPair("jellyfin_to_plex");
    mock.writes = [];
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true });
    mock.setJellyfin("jf1", "jf-alex", beta.jellyfinId, { watched: true });
    mock.setJellyfin("jf1", "jf-alex", gamma.jellyfinId, { offsetMs: 2_400_000 });
    await tick();
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`).sort()).toEqual(["plex:progress:13", "plex:scrobble:12"]);
    expect(mock.jellyfinState("jf1", "jf-alex", alpha.jellyfinId).watched).toBe(false);
  });

  it("syncs both ways and lets the newest change win a conflict", async () => {
    await connectedPair("both");
    mock.writes = [];
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true });
    mock.setJellyfin("jf1", "jf-alex", beta.jellyfinId, { watched: true });
    // Gamma changed on both sides: a resume point on Plex, then a finished watch on Jellyfin.
    mock.setPlex(mock.ownerToken, gamma.plexKey, { offsetMs: 300_000, at: minutesAgo(3) });
    mock.setJellyfin("jf1", "jf-alex", gamma.jellyfinId, { watched: true, at: minutesAgo(1) });
    await tick();
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`).sort()).toEqual(["jf1:played:a1", "plex:scrobble:12", "plex:scrobble:13"]);
    expect(mock.plexState(mock.ownerToken, gamma.plexKey).watched).toBe(true);
  });

  it("propagates unwatched from either side", async () => {
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true, at: minutesAgo(90) });
    mock.setPlex(mock.ownerToken, beta.plexKey, { watched: true, at: minutesAgo(90) });
    await connectedPair("both");
    expect(mock.jellyfinState("jf1", "jf-alex", alpha.jellyfinId).watched).toBe(true);
    mock.writes = [];
    // Jellyfin reports unplayed items through MinDateLastSavedForUser.
    mock.setJellyfin("jf1", "jf-alex", alpha.jellyfinId, { watched: false });
    // Plex reports nothing when an item is marked unwatched; the rolling recheck finds it.
    mock.plexUser(mock.ownerToken).set(beta.plexKey, { viewCount: 0, viewOffset: 0, lastViewedAt: Math.floor(minutesAgo(90).getTime() / 1000) });
    await tick();
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`).sort()).toEqual(["jf1:unplayed:b2", "plex:unscrobble:11"]);
    expect(mock.plexState(mock.ownerToken, alpha.plexKey).watched).toBe(false);
    expect(mock.jellyfinState("jf1", "jf-alex", beta.jellyfinId).watched).toBe(false);
  });

  it("does not ping-pong its own writes", async () => {
    await connectedPair("both");
    mock.writes = [];
    mock.setJellyfin("jf1", "jf-alex", alpha.jellyfinId, { offsetMs: 1_800_000 });
    mock.setPlex(mock.ownerToken, beta.plexKey, { watched: true });
    await tick();
    expect(mock.writes).toHaveLength(2);
    for (let pass = 0; pass < 3; pass += 1) await tick();
    expect(mock.writes).toHaveLength(2);
    await job({ mode: "reconcile", pairIds: [(await state()).pairs[0]!.id] });
    expect(mock.writes).toHaveLength(2);
  });

  it("reads only what changed since the cursors and moves them forward", async () => {
    const { pairId } = await connectedPair("both");
    const pair = (await app.database.db.select().from(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, pairId)))[0]!;
    expect(Number(pair.plexCursor)).toBeGreaterThan(Date.now() / 1000 - 120);
    expect(Date.parse(pair.jellyfinCursor!)).toBeGreaterThan(Date.now() - 120_000);
    mock.requests = [];
    await tick();
    const listings = mock.requests.filter((request) => /\/library\/sections\/\d+\/all|\/Items\?/.test(request));
    expect(listings.length).toBeGreaterThan(0);
    // Every listing is filtered; a full library read never happens on the timer.
    for (const request of listings) expect(decodeURIComponent(request)).toMatch(/lastViewedAt>>=|addedAt>>=|MinDateLastSavedForUser=|MinDateLastSaved=|Ids=/);
    const since = Number(decodeURIComponent(listings.find((request) => decodeURIComponent(request).includes("lastViewedAt>>="))!).match(/lastViewedAt>>=(\d+)/)![1]);
    expect(since).toBe(Number(pair.plexCursor) - 120);
    // Music libraries are never read.
    expect(mock.requests.some((request) => request.includes("/library/sections/3/"))).toBe(false);

    // A play that only shows up in the owner's history is found through it.
    mock.plexUser(mock.ownerToken).set(gamma.plexKey, { viewCount: 1, viewOffset: 0, lastViewedAt: 1 });
    mock.plexHistory.push({ ratingKey: gamma.plexKey, accountID: "1", viewedAt: Math.floor(Date.now() / 1000) });
    mock.writes = [];
    await tick();
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`)).toEqual(["jf1:played:c3"]);
    const moved = (await app.database.db.select().from(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, pairId)))[0]!;
    expect(Number(moved.plexCursor)).toBeGreaterThanOrEqual(Number(pair.plexCursor));
  });

  it("keeps other pairs syncing while one server is down, and backs off the failed pair", async () => {
    mock.addJellyfin("jf2", { users: [{ id: "jf2-alex", name: "Alex" }], legacyOnly: true });
    const first = await connectedPair("plex_to_jellyfin", "jf1");
    const second = await connectedPair("plex_to_jellyfin", "jf2", "jf2-alex");
    mock.writes = [];
    mock.jellyfin.get("jf2")!.offline = true;
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true });
    const result = await tick();
    expect(result).toMatchObject({ synced: 1, failed: 1 });
    expect(mock.writes.map((write) => `${write.server}:${write.action}:${write.item}`)).toEqual(["jf1:played:a1"]);
    const pairs = (await state()).pairs;
    expect(pairs.find((pair) => pair.id === first.pairId)?.lastError).toBeNull();
    expect(pairs.find((pair) => pair.id === second.pairId)?.lastError).toContain("HTTP 503");
    expect((await state()).settings.servers.find((server) => server.id === second.jellyfinId)?.lastError).toContain("HTTP 503");
    const failed = (await app.database.db.select().from(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, second.pairId)))[0]!;
    expect(Date.parse(failed.nextAttemptAt!)).toBeGreaterThan(Date.now());

    // Back online, the pair catches up through the legacy Jellyfin routes once its retry is due.
    mock.jellyfin.get("jf2")!.offline = false;
    await app.database.db.update(schema.watchSyncPairs).set({ nextAttemptAt: null }).where(eq(schema.watchSyncPairs.id, second.pairId));
    await tick();
    expect(mock.jellyfinState("jf2", "jf2-alex", alpha.jellyfinId).watched).toBe(true);
    expect((await state()).pairs.find((pair) => pair.id === second.pairId)?.lastError).toBeNull();
  });

  it("isolates a Plex outage and a failing history endpoint", async () => {
    await connectedPair("both");
    mock.plexHistoryFails = true;
    mock.setJellyfin("jf1", "jf-alex", alpha.jellyfinId, { watched: true });
    expect(await tick()).toMatchObject({ synced: 1, failed: 0 });
    expect(mock.plexState(mock.ownerToken, alpha.plexKey).watched).toBe(true);
    mock.plexOffline = true;
    expect(await tick()).toMatchObject({ synced: 0, failed: 1 });
    expect((await state()).pairs[0]?.lastError).toContain("Home Plex");
  });

  it("syncs a friend through the friend's own Plex token, one-to-many", async () => {
    await connectedPair("both");
    const plexId = (await state()).settings.servers.find((server) => server.kind === "plex")!.id;
    const jellyfinId = (await state()).settings.servers.find((server) => server.name === "jf1")!.id;
    // One Plex user may feed several Jellyfin users.
    await createWatchSyncPair(app.database.db, { plexServerId: plexId, plexUserId: "200", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-bob" });
    await createWatchSyncPair(app.database.db, { plexServerId: plexId, plexUserId: "200", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-alex", direction: "plex_to_jellyfin" });
    await expect(createWatchSyncPair(app.database.db, { plexServerId: plexId, plexUserId: "200", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-bob" })).rejects.toThrow("already paired");
    mock.setPlex("tok-bob", beta.plexKey, { watched: true });
    const bobPair = (await state()).pairs.find((pair) => pair.plexUserId === "200" && pair.jellyfinUserId === "jf-bob")!.id;
    await job({ mode: "preview", pairIds: [bobPair] });
    await approveWatchSyncPair(app.database.db, bobPair);
    await job({ mode: "reconcile", pairIds: [bobPair] });
    expect(mock.jellyfinState("jf1", "jf-bob", beta.jellyfinId).watched).toBe(true);
    expect(mock.plexState(mock.ownerToken, beta.plexKey).watched).toBe(false);
  });

  it("pauses globally and per pair", async () => {
    const { pairId } = await connectedPair("both");
    mock.writes = [];
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true });
    await setWatchSyncPaused(app.database.db, true);
    expect(await tick()).toMatchObject({ synced: 0 });
    await setWatchSyncPaused(app.database.db, false);
    await updateWatchSyncPair(app.database.db, pairId, { paused: true });
    expect(await tick()).toMatchObject({ synced: 0 });
    expect(mock.writes).toEqual([]);
    await updateWatchSyncPair(app.database.db, pairId, { paused: false });
    expect(await tick()).toMatchObject({ synced: 1 });
    expect(mock.writes).toHaveLength(1);
  });

  it("exports a pair's watch state and restores it to a server", async () => {
    mock.setPlex(mock.ownerToken, alpha.plexKey, { watched: true, at: minutesAgo(90) });
    mock.setPlex(mock.ownerToken, gamma.plexKey, { offsetMs: 1_500_000, at: minutesAgo(80) });
    const { pairId } = await connectedPair("both");
    const backup = await exportWatchSyncBackup(app.database.db, pairId);
    expect(backup.items.map((entry) => [path.posix.basename(entry.linkPath), entry.jellyfin?.watched, entry.jellyfin?.positionMs])).toEqual([
      ["Alpha.mkv", true, 0],
      ["Gamma.mkv", false, 1_500_000]
    ]);
    // Jellyfin loses its data, then the backup puts it back.
    mock.jellyfin.get("jf1")!.data.clear();
    mock.writes = [];
    const backupKey = "restore:test";
    await writeCursor(app.database.db, backupKey, JSON.stringify(backup));
    await job({ mode: "restore", pairIds: [pairId], restore: { side: "jellyfin", backupKey } });
    expect(mock.jellyfinState("jf1", "jf-alex", alpha.jellyfinId).watched).toBe(true);
    expect(mock.jellyfinState("jf1", "jf-alex", gamma.jellyfinId).offsetMs).toBe(1_500_000);
    expect(mock.writes.every((write) => write.server === "jf1")).toBe(true);
  });

  it("queues the periodic full reconciliation once due and retries a failed first sync", async () => {
    await connectedPair("both");
    const queued: WatchSyncJobOptions[] = [];
    const enqueue = async (options: WatchSyncJobOptions) => { queued.push(options); return queued.length; };
    expect(await scheduleWatchSyncReconcile(app.database.db, enqueue)).toBeNull();
    await writeCursor(app.database.db, "reconcile:last", new Date(Date.now() - 8 * 86400_000).toISOString());
    expect(await scheduleWatchSyncReconcile(app.database.db, enqueue)).toBe(1);
    expect(queued[0]).toMatchObject({ mode: "reconcile", scheduled: true });
    // A failed run is not re-queued on every pass.
    expect(await scheduleWatchSyncReconcile(app.database.db, enqueue)).toBeNull();
    await app.database.db.update(schema.watchSyncPairs).set({ lastFullSyncAt: null });
    expect(await scheduleWatchSyncReconcile(app.database.db, enqueue)).toBe(2);
    expect(queued[1]).toMatchObject({ mode: "reconcile", pairIds: [(await state()).pairs[0]!.id] });
  });

  it("serves the settings API to signed-in admins and runs watch sync jobs on the worker", async () => {
    expect((await app.app.inject({ method: "GET", url: "/api/settings/watch-sync" })).statusCode).toBe(401);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const created = await app.app.inject({ method: "POST", url: "/api/settings/watch-sync/servers", headers: { cookie }, payload: { kind: "jellyfin", name: "jf1", url: `${mock.base}/jf1`, token: mock.jellyfin.get("jf1")!.apiKey, prefixMappings: [] } });
    expect(created.statusCode).toBe(200);
    const plexId = await signInPlex();
    const jellyfinId = (created.json() as WatchSyncState).settings.servers[0]!.id;
    expect((await app.app.inject({ method: "POST", url: `/api/settings/watch-sync/servers/${jellyfinId}/discover`, headers: { cookie } })).statusCode).toBe(200);
    const paired = await app.app.inject({ method: "POST", url: "/api/settings/watch-sync/pairs", headers: { cookie }, payload: { plexServerId: plexId, plexUserId: "100", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-alex", direction: "both" } });
    const pairId = (paired.json() as WatchSyncState).pairs[0]!.id;
    expect((await app.app.inject({ method: "POST", url: `/api/settings/watch-sync/pairs/${pairId}/approve`, headers: { cookie } })).statusCode).toBe(400);
    const preview = await app.app.inject({ method: "POST", url: `/api/settings/watch-sync/pairs/${pairId}/preview`, headers: { cookie } });
    const worker = new JobWorker(app.database.db, { workerId: "watch-sync-test", logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await worker.runOnce();
    expect((await app.jobs.getJob(preview.json().jobId))?.status).toBe("completed");
    expect((await state()).pairs[0]?.preview).not.toBeNull();
    const settings = (await state()).settings;
    await saveWatchSyncSettings(app.database.db, { revision: settings.revision, paused: false, intervalMinutes: 10, reconcileIntervalDays: 3, syncWatched: true, syncPosition: false });
    expect((await state()).settings).toMatchObject({ intervalMinutes: 10, reconcileIntervalDays: 3, syncPosition: false });
    const backup = await app.app.inject({ method: "GET", url: `/api/settings/watch-sync/pairs/${pairId}/backup`, headers: { cookie } });
    expect(backup.headers["content-disposition"]).toContain("attachment");
    expect(backup.json()).toMatchObject({ format: "srtl-watch-sync", items: [] });
  });
});
