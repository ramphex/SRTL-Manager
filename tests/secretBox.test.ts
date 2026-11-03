import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { getSetting, openDatabase } from "../src/server/db/database";
import { encryptStoredSecrets, secretKeyCheckSetting, StoredCredentialsKeyError } from "../src/server/db/secretMigration";
import { getMediaServer } from "../src/server/lib/mediaServers";
import {
  activeSecretBox,
  installSecretBox,
  loadSecretKey,
  parseSecretKey,
  SecretBox,
  SecretDecryptError,
  SecretKeyError,
  SecretKeyMismatchError,
  secretPurposes
} from "../src/server/lib/secretBox";
import { createTestDatabase } from "./testDb";
import { testSecretKey } from "./setup";

const testBox = () => new SecretBox(parseSecretKey(testSecretKey, "test key"));
const otherKey = () => randomBytes(32);

describe("secret box", () => {
  it("round-trips values and never stores them readably", () => {
    const box = new SecretBox(randomBytes(32));
    for (const value of ["example-token", "ünïcödé-key", "a".repeat(500)]) {
      const sealed = box.seal(value, secretPurposes.mediaServerToken);
      expect(sealed.startsWith(`enc:v1:${box.keyId}:`)).toBe(true);
      expect(sealed).not.toContain(value);
      expect(box.open(sealed, secretPurposes.mediaServerToken)).toBe(value);
    }
    // A fresh IV every time: the same value never seals to the same text.
    expect(box.seal("same", secretPurposes.mediaServerToken)).not.toBe(box.seal("same", secretPurposes.mediaServerToken));
    // Values from before encryption existed read as they are.
    expect(box.open("legacy-plaintext", secretPurposes.mediaServerToken)).toBe("legacy-plaintext");
  });

  it("detects tampering with any part of a sealed value, or moving it to another field", () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal("example-token", secretPurposes.radarrApiKey);
    const parts = sealed.split(":");
    const flip = (text: string) => {
      const bytes = Buffer.from(text, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString("base64url");
    };
    for (const index of [3, 4, 5]) {
      const changed = [...parts];
      changed[index] = flip(changed[index]!);
      expect(() => box.open(changed.join(":"), secretPurposes.radarrApiKey)).toThrow(SecretDecryptError);
    }
    expect(() => box.open(sealed.slice(0, -4), secretPurposes.radarrApiKey)).toThrow(SecretDecryptError);
    expect(() => box.open(`${sealed}:extra`, secretPurposes.radarrApiKey)).toThrow(SecretDecryptError);
    expect(() => box.open(sealed, secretPurposes.sonarrApiKey)).toThrow(SecretDecryptError);
    // The version and key id are authenticated too.
    const withPart = (index: number, value: string) => parts.map((part, at) => at === index ? value : part).join(":");
    expect(() => box.open(withPart(1, "v2"), secretPurposes.radarrApiKey)).toThrow(SecretDecryptError);
    expect(() => box.open(withPart(2, "0".repeat(16)), secretPurposes.radarrApiKey)).toThrow(SecretKeyMismatchError);
  });

  it("rejects a value sealed with another key, and reads it once that key is kept for rotation", () => {
    const oldKey = otherKey();
    const sealed = new SecretBox(oldKey).seal("example-token", secretPurposes.mediaServerToken);
    const newKey = otherKey();
    expect(() => new SecretBox(newKey).open(sealed, secretPurposes.mediaServerToken)).toThrow(SecretKeyMismatchError);
    const rotated = new SecretBox(newKey, [oldKey]);
    expect(rotated.open(sealed, secretPurposes.mediaServerToken)).toBe("example-token");
    expect(rotated.seal("example-token", secretPurposes.mediaServerToken)).toContain(`:${rotated.keyId}:`);
  });

  it("accepts base64, base64url and hex keys and never repeats a rejected value", () => {
    const key = randomBytes(32);
    for (const text of [key.toString("base64"), key.toString("base64url"), key.toString("hex"), ` ${key.toString("base64")}\n`]) {
      expect(parseSecretKey(text, "SRTL_SECRET_KEY").equals(key)).toBe(true);
    }
    for (const text of ["short-value", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), "z".repeat(64)]) {
      let message = "";
      try { parseSecretKey(text, "SRTL_SECRET_KEY"); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("SRTL_SECRET_KEY must be 32 random bytes");
      expect(message).not.toContain(text);
    }
  });
});

describe("secret key loading", () => {
  let root = "";
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = "";
  });

  it("prefers SRTL_SECRET_KEY, then SRTL_SECRET_KEY_FILE, then the data directory key file", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-secret-key-"));
    const dataDir = path.join(root, "data");
    const fromEnvironment = randomBytes(32);
    const keyFile = path.join(root, "docker-secret");
    const fromFile = randomBytes(32);
    await fs.writeFile(keyFile, `${fromFile.toString("base64")}\n`);
    expect(loadSecretKey({ key: fromEnvironment.toString("base64"), keyFile, dataDir, temporaryDirs: [] })).toMatchObject({ source: "environment", path: null });
    const file = loadSecretKey({ keyFile, dataDir, temporaryDirs: [] });
    expect(file).toMatchObject({ source: "file", path: keyFile });
    expect(file.box.keyId).toBe(new SecretBox(fromFile).keyId);
    await expect(fs.access(path.join(dataDir, "secret.key"))).rejects.toThrow();
    expect(() => loadSecretKey({ keyFile: path.join(root, "missing"), dataDir, temporaryDirs: [] })).toThrow(/SRTL_SECRET_KEY_FILE .*missing could not be read/);
  });

  it("creates a 0600 key file on first start and reuses it afterwards", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-secret-key-"));
    const dataDir = path.join(root, "data");
    const first = loadSecretKey({ dataDir, temporaryDirs: [] });
    expect(first).toMatchObject({ source: "generated", path: path.join(dataDir, "secret.key") });
    expect((await fs.stat(first.path!)).mode & 0o777).toBe(0o600);
    const second = loadSecretKey({ dataDir, temporaryDirs: [] });
    expect(second).toMatchObject({ source: "file" });
    expect(second.box.keyId).toBe(first.box.keyId);
    expect((await fs.readdir(dataDir)).sort()).toEqual(["secret.key"]);
  });

  it("never generates a key where it would be lost on restart", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-secret-key-"));
    expect(() => loadSecretKey({ dataDir: path.join(root, "data"), temporaryDirs: [root] })).toThrow(/SRTL_SECRET_KEY is not set, and the data directory .* is temporary/);
    await expect(fs.access(path.join(root, "data", "secret.key"))).rejects.toThrow();
  });

  it("fails clearly when the configured key is malformed", () => {
    expect(() => loadSecretKey({ key: "not-a-key", dataDir: "/nonexistent", temporaryDirs: [] })).toThrow(SecretKeyError);
  });
});

describe("stored credential migration", () => {
  afterEach(() => installSecretBox(testBox()));

  async function seedPlaintext(databaseUrl: string) {
    const database = await openDatabase(databaseUrl);
    const timestamp = new Date().toISOString();
    await database.pool.query(`INSERT INTO media_servers (id, kind, name, url, token, created_at, updated_at) VALUES ('plex1', 'plex', 'Plex', 'http://192.168.1.10:32400', 'plain-plex-token', $1, $1), ('jf1', 'jellyfin', 'Jellyfin', 'http://192.168.1.11:8096', 'plain-jellyfin-key', $1, $1), ('empty1', 'plex', 'Unsigned', 'http://192.168.1.12:32400', '', $1, $1)`, [timestamp]);
    await database.pool.query(`INSERT INTO watch_sync_users (server_id, external_id, name, kind, access_token, updated_at) VALUES ('plex1', '1', 'Owner', 'owner', 'plain-user-token', $1), ('plex1', '2', 'Friend', 'friend', NULL, $1)`, [timestamp]);
    await database.pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('radarrInstances', $1, $3), ('sonarrInstances', $2, $3)`, [
      JSON.stringify({ instances: [{ id: "r1", name: "Radarr", apiKey: "plainRadarrKey", webhookSecretHash: "abc" }, { id: "r2", name: "Radarr 4K", apiKey: "" }], legacyWebhookInstanceId: null }),
      JSON.stringify({ instances: [{ id: "s1", name: "Sonarr", apiKey: "plainSonarrKey" }], legacyWebhookInstanceId: null }),
      timestamp
    ]);
    // Pretend the rows predate migration 26.
    await database.pool.query(`DELETE FROM schema_migrations WHERE version = 26`);
    await database.pool.query(`DELETE FROM app_settings WHERE key = $1`, [secretKeyCheckSetting]);
    return database;
  }

  async function snapshot(pool: Pool) {
    const setting = async (key: string) => (await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [key])).rows[0]?.value ?? null;
    return {
      servers: (await pool.query<{ id: string; token: string }>(`SELECT id, token FROM media_servers ORDER BY id`)).rows,
      users: (await pool.query<{ external_id: string; access_token: string | null }>(`SELECT external_id, access_token FROM watch_sync_users ORDER BY external_id`)).rows,
      radarr: await setting("radarrInstances"),
      sonarr: await setting("sonarrInstances")
    };
  }

  it("encrypts plaintext credentials in place, once", async () => {
    const handle = await createTestDatabase();
    try {
      await (await seedPlaintext(handle.databaseUrl)).close();
      const database = await openDatabase(handle.databaseUrl);
      try {
        const after = await snapshot(database.pool);
        const text = JSON.stringify(after);
        for (const plaintext of ["plain-plex-token", "plain-jellyfin-key", "plain-user-token", "plainRadarrKey", "plainSonarrKey"]) expect(text).not.toContain(plaintext);
        expect(after.servers.find((row) => row.id === "empty1")?.token).toBe("");
        expect(after.users.find((row) => row.external_id === "2")?.access_token).toBeNull();
        expect((await getMediaServer(database.db, "plex1")).token).toBe("plain-plex-token");
        expect((await getMediaServer(database.db, "jf1")).token).toBe("plain-jellyfin-key");
        const box = activeSecretBox();
        expect(box.open(after.users.find((row) => row.external_id === "1")!.access_token!, secretPurposes.watchSyncUserToken)).toBe("plain-user-token");
        const radarr = JSON.parse(after.radarr!) as { instances: Array<{ apiKey: string; webhookSecretHash?: string }> };
        expect(box.open(radarr.instances[0]!.apiKey, secretPurposes.radarrApiKey)).toBe("plainRadarrKey");
        expect(radarr.instances[0]!.webhookSecretHash).toBe("abc");
        expect(radarr.instances[1]!.apiKey).toBe("");
        expect(box.open((JSON.parse(after.sonarr!) as { instances: Array<{ apiKey: string }> }).instances[0]!.apiKey, secretPurposes.sonarrApiKey)).toBe("plainSonarrKey");
        expect(await getSetting(database.db, secretKeyCheckSetting)).toMatch(/enc:v1:/);
        expect((await database.pool.query(`SELECT name FROM schema_migrations WHERE version = 26`)).rows).toEqual([{ name: "encrypt_stored_credentials" }]);

        // Running it again changes nothing.
        const client = await database.pool.connect();
        try {
          expect(await encryptStoredSecrets(client, box, new Date().toISOString())).toBe(0);
        } finally {
          client.release();
        }
        expect(await snapshot(database.pool)).toEqual(after);
      } finally {
        await database.close();
      }
    } finally {
      await handle.cleanup();
    }
  });

  it("refuses to start with a different key, and only drops the unreadable credentials when asked", async () => {
    const handle = await createTestDatabase();
    try {
      await (await seedPlaintext(handle.databaseUrl)).close();
      await (await openDatabase(handle.databaseUrl)).close();
      const before = await (async () => {
        const database = await openDatabase(handle.databaseUrl);
        try { return await snapshot(database.pool); } finally { await database.close(); }
      })();

      installSecretBox(new SecretBox(otherKey()));
      const refused = openDatabase({ databaseUrl: handle.databaseUrl, migrate: false });
      await expect(refused).rejects.toThrow(StoredCredentialsKeyError);
      await expect(openDatabase({ databaseUrl: handle.databaseUrl, migrate: true })).rejects.toThrow(/encrypted with secret key [0-9a-f]{16}, but the configured secret key is [0-9a-f]{16}.*SRTL_DISCARD_UNREADABLE_CREDENTIALS=true/);

      installSecretBox(testBox());
      const unchanged = await openDatabase(handle.databaseUrl);
      try { expect(await snapshot(unchanged.pool)).toEqual(before); } finally { await unchanged.close(); }

      const replacement = new SecretBox(otherKey());
      installSecretBox(replacement);
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message: string) => { warnings.push(message); };
      let discarded;
      try {
        discarded = await openDatabase({ databaseUrl: handle.databaseUrl, discardUnreadableCredentials: true });
      } finally {
        console.warn = originalWarn;
      }
      try {
        expect(warnings.join("\n")).toContain("2 media server token(s), 1 watch sync user token(s), 2 Radarr or Sonarr API key(s)");
        const after = await snapshot(discarded.pool);
        expect(after.servers.map((row) => row.token)).toEqual(["", "", ""]);
        expect(after.users.map((row) => row.access_token)).toEqual([null, null]);
        expect(JSON.stringify(after)).not.toContain("enc:v1:");
        const server = await getMediaServer(discarded.db, "plex1");
        expect(server.lastError).toContain("could not be decrypted");
      } finally {
        await discarded.close();
      }
      // The replacement key is now the recorded one, so the next start needs no flag.
      await (await openDatabase({ databaseUrl: handle.databaseUrl, migrate: false })).close();
    } finally {
      await handle.cleanup();
    }
  });
});
