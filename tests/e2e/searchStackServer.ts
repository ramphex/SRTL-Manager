// The server side of search-stack.spec.ts, run under tsx: the real API and database with made-up library links, so the
// dashboard work search goes through the real query and the generated search column.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "../setup";
import { createApp } from "../../src/server/app";
import * as schema from "../../src/server/db/schema";
import { markOnboardingCompleteForExistingInstall } from "../../src/server/lib/onboarding";
import { persistSectionSettings } from "../../src/server/lib/sectionSettings";
import { readSetupToken } from "../authHelpers";
import { createTestDatabase } from "../testDb";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const ownerPassword = "owner-password-for-tests";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-search-stack-"));
for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
const database = await createTestDatabase();
const app = await createApp({ rootDir: root, dataDir: path.join(root, "data"), webRoot: path.join(repoRoot, "dist", "client"), databaseUrl: database.databaseUrl, autoMigrate: true, anonymousRequestsPerMinute: 100_000, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
app.app.log.level = "silent";
const { db } = app.database;
await markOnboardingCompleteForExistingInstall(db);
await persistSectionSettings(db, { sections: ["movies"], sectionTypes: { movies: "movies" } });

const now = new Date().toISOString();
const movies: Array<[string, string]> = [
  ["Alpha Bravo (2019)", "Alpha.Bravo.2019.1080p.mkv"],
  ["Charlie's Lab (2020)", "Charlie's.Lab.2020.1080p.mkv"],
  ["Delta! Echo (2021)", "Delta.Echo.2021.1080p.mkv"],
  ["Foxtrot Golf (2018)", "Foxtrot.Golf.2018.1080p.mkv"]
];
for (const [itemName, file] of movies) {
  const relativePath = `${itemName}/${file}`;
  await db.insert(schema.mediaLinks).values({
    section: "movies",
    itemName,
    relativePath,
    linkPath: path.join(root, "links", "movies", relativePath),
    targetPath: path.join(root, "remote", "movies", file.replace(/\.mkv$/, ""), file),
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "unassigned",
    lastSeenAt: now,
    updatedAt: now
  });
}

const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "the-owner", password: ownerPassword, confirmPassword: ownerPassword } });
if (setup.statusCode !== 200) throw new Error("Could not create the test owner");

const baseUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });

async function shutDown() {
  await app.app.close();
  await database.cleanup();
  await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void shutDown());

process.stdout.write(`STACK_READY ${JSON.stringify({ baseUrl })}\n`);
