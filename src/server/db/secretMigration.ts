import type { Pool, PoolClient } from "pg";
import { isSealedSecret, SecretDecryptError, SecretKeyMismatchError, secretPurposes, type SecretBox, type SecretPurpose } from "../lib/secretBox";

type Queryable = Pick<PoolClient, "query">;

export const secretKeyCheckSetting = "secretKeyCheck";
const keyCheckPlaintext = "srtl-secret-key-check";
const arrSettings: ReadonlyArray<{ key: string; purpose: SecretPurpose; name: string }> = [
  { key: "radarrInstances", purpose: secretPurposes.radarrApiKey, name: "Radarr" },
  { key: "sonarrInstances", purpose: secretPurposes.sonarrApiKey, name: "Sonarr" }
];

async function tableExists(client: Queryable, table: string): Promise<boolean> {
  return Boolean((await client.query<{ name: string | null }>(`SELECT to_regclass($1)::text AS name`, [`public.${table}`])).rows[0]?.name);
}

interface ArrSetting { instances?: Array<Record<string, unknown>>; [key: string]: unknown }

function parseArrSetting(raw: string): ArrSetting | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as ArrSetting : null;
  } catch {
    return null;
  }
}

async function readArrSettings(client: Queryable): Promise<Array<{ key: string; purpose: SecretPurpose; name: string; value: ArrSetting }>> {
  if (!await tableExists(client, "app_settings")) return [];
  const rows = (await client.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [arrSettings.map((entry) => entry.key)])).rows;
  return rows.flatMap((row) => {
    const definition = arrSettings.find((entry) => entry.key === row.key)!;
    const value = parseArrSetting(row.value);
    return value ? [{ ...definition, value }] : [];
  });
}

async function writeKeyCheck(client: Queryable, box: SecretBox, timestamp: string): Promise<void> {
  const value = JSON.stringify({ value: box.seal(keyCheckPlaintext, secretPurposes.keyCheck) });
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [secretKeyCheckSetting, value, timestamp]
  );
}

/**
 * Migration 26: seals every stored credential that is still plaintext and records which key sealed them. Values
 * already sealed are left alone, so running it again changes nothing.
 */
export async function encryptStoredSecrets(client: Queryable, box: SecretBox, timestamp: string): Promise<number> {
  let sealed = 0;
  if (await tableExists(client, "media_servers")) {
    const rows = (await client.query<{ id: string; token: string }>(`SELECT id, token FROM media_servers WHERE token <> '' AND token NOT LIKE 'enc:%'`)).rows;
    for (const row of rows) {
      await client.query(`UPDATE media_servers SET token = $1 WHERE id = $2 AND token = $3`, [box.seal(row.token, secretPurposes.mediaServerToken), row.id, row.token]);
      sealed += 1;
    }
  }
  if (await tableExists(client, "watch_sync_users")) {
    const rows = (await client.query<{ server_id: string; external_id: string; access_token: string }>(
      `SELECT server_id, external_id, access_token FROM watch_sync_users WHERE access_token IS NOT NULL AND access_token <> '' AND access_token NOT LIKE 'enc:%'`
    )).rows;
    for (const row of rows) {
      await client.query(`UPDATE watch_sync_users SET access_token = $1 WHERE server_id = $2 AND external_id = $3 AND access_token = $4`, [
        box.seal(row.access_token, secretPurposes.watchSyncUserToken), row.server_id, row.external_id, row.access_token
      ]);
      sealed += 1;
    }
  }
  for (const setting of await readArrSettings(client)) {
    let changed = false;
    const instances = (setting.value.instances ?? []).map((instance) => {
      const apiKey = instance.apiKey;
      if (typeof apiKey !== "string" || !apiKey || isSealedSecret(apiKey)) return instance;
      changed = true;
      sealed += 1;
      return { ...instance, apiKey: box.seal(apiKey, setting.purpose) };
    });
    if (changed) await client.query(`UPDATE app_settings SET value = $1, updated_at = $2 WHERE key = $3`, [JSON.stringify({ ...setting.value, instances }), timestamp, setting.key]);
  }
  if (await tableExists(client, "app_settings")) {
    const existing = (await client.query(`SELECT 1 FROM app_settings WHERE key = $1`, [secretKeyCheckSetting])).rows.length > 0;
    if (!existing) await writeKeyCheck(client, box, timestamp);
  }
  return sealed;
}

/** Every sealed credential, for checking which keys they need. */
async function sealedValues(client: Queryable): Promise<string[]> {
  const values: string[] = [];
  if (await tableExists(client, "media_servers")) {
    values.push(...(await client.query<{ token: string }>(`SELECT token FROM media_servers WHERE token LIKE 'enc:%'`)).rows.map((row) => row.token));
  }
  if (await tableExists(client, "watch_sync_users")) {
    values.push(...(await client.query<{ access_token: string }>(`SELECT access_token FROM watch_sync_users WHERE access_token LIKE 'enc:%'`)).rows.map((row) => row.access_token));
  }
  for (const setting of await readArrSettings(client)) {
    for (const instance of setting.value.instances ?? []) if (isSealedSecret(instance.apiKey as string | undefined)) values.push(instance.apiKey as string);
  }
  return values;
}

export class StoredCredentialsKeyError extends SecretKeyMismatchError {
  constructor(storedKeyId: string, currentKeyId: string) {
    super(storedKeyId, currentKeyId);
    this.message = [
      `Stored credentials were encrypted with secret key ${storedKeyId}, but the configured secret key is ${currentKeyId}.`,
      "SRTL Manager will not start with a different key, because it could not read the saved Plex tokens and Jellyfin, Radarr and Sonarr API keys.",
      "Restore the original SRTL_SECRET_KEY, SRTL_SECRET_KEY_FILE or data-directory secret.key and start again.",
      "If the original key is lost, start once with SRTL_DISCARD_UNREADABLE_CREDENTIALS=true to remove the unreadable credentials, then enter them again in Settings."
    ].join(" ");
  }
}

export interface DiscardResult { mediaServers: number; watchSyncUsers: number; arrInstances: number }

// Removes the credentials no configured key can open. Only ever runs when the admin asked for it.
async function discardUnreadableSecrets(client: Queryable, box: SecretBox, timestamp: string): Promise<DiscardResult> {
  const result: DiscardResult = { mediaServers: 0, watchSyncUsers: 0, arrInstances: 0 };
  if (await tableExists(client, "media_servers")) {
    for (const row of (await client.query<{ id: string; token: string }>(`SELECT id, token FROM media_servers WHERE token LIKE 'enc:%'`)).rows) {
      if (box.canOpen(row.token)) continue;
      await client.query(
        `UPDATE media_servers SET token = '', pending_pin = NULL, machine_identifier = NULL, account_name = NULL, account_id = NULL, version = NULL,
           last_checked_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1`,
        [row.id, "The saved token or API key could not be decrypted with the current secret key. Sign in or enter it again.", timestamp]
      );
      result.mediaServers += 1;
    }
  }
  if (await tableExists(client, "watch_sync_users")) {
    for (const row of (await client.query<{ server_id: string; external_id: string; access_token: string }>(`SELECT server_id, external_id, access_token FROM watch_sync_users WHERE access_token LIKE 'enc:%'`)).rows) {
      if (box.canOpen(row.access_token)) continue;
      await client.query(`UPDATE watch_sync_users SET access_token = NULL, available = false, note = $3, updated_at = $4 WHERE server_id = $1 AND external_id = $2`, [
        row.server_id, row.external_id, "The saved access token could not be decrypted. Sign in with Plex again, then discover users again.", timestamp
      ]);
      result.watchSyncUsers += 1;
    }
  }
  for (const setting of await readArrSettings(client)) {
    let changed = false;
    const instances = (setting.value.instances ?? []).map((instance) => {
      const apiKey = instance.apiKey as string | undefined;
      if (!isSealedSecret(apiKey) || box.canOpen(apiKey)) return instance;
      changed = true;
      result.arrInstances += 1;
      return { ...instance, apiKey: "", lastError: `The saved ${setting.name} API key could not be decrypted with the current secret key. Enter it again.` };
    });
    if (changed) await client.query(`UPDATE app_settings SET value = $1, updated_at = $2 WHERE key = $3`, [JSON.stringify({ ...setting.value, instances }), timestamp, setting.key]);
  }
  return result;
}

function storedKeyId(value: string): string {
  return value.split(":")[2] ?? "unknown";
}

export interface VerifySecretKeyOptions {
  discardUnreadable?: boolean;
  lockKey: number;
  timestamp: string;
  warn?: (message: string) => void;
}

/**
 * Confirms at startup that the configured key opens the stored credentials, so a missing or wrong key stops SRTL
 * with a clear message instead of failing on every request or losing credentials. With `discardUnreadable`, the
 * credentials no key can open are removed instead, and the current key becomes the recorded one.
 */
export async function verifySecretKey(pool: Pool, box: SecretBox, options: VerifySecretKeyOptions): Promise<void> {
  const client = await pool.connect();
  try {
    // A partial legacy schema has nowhere to keep settings, and so no stored credentials either.
    if (!await tableExists(client, "app_settings")) return;
    const raw =(await client.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [secretKeyCheckSetting])).rows[0]?.value;
    let check: string | null = null;
    try { check = raw ? (JSON.parse(raw) as { value?: unknown }).value as string ?? null : null; } catch { check = null; }
    const unreadable = check
      ? (box.canOpen(check) ? [] : [check])
      : (await sealedValues(client)).filter((value) => !box.canOpen(value));
    if (check && unreadable.length === 0) {
      // The key id matched, so a failure here means the stored check itself was changed.
      if (box.open(check, secretPurposes.keyCheck) !== keyCheckPlaintext) throw new SecretDecryptError();
      return;
    }
    if (unreadable.length > 0 && !options.discardUnreadable) throw new StoredCredentialsKeyError(storedKeyId(unreadable[0]!), box.keyId);
    await client.query("BEGIN");
    try {
      await client.query("select pg_advisory_xact_lock($1)", [options.lockKey]);
      if (unreadable.length > 0) {
        const removed = await discardUnreadableSecrets(client, box, options.timestamp);
        options.warn?.(
          `SRTL_DISCARD_UNREADABLE_CREDENTIALS removed credentials sealed with secret key ${storedKeyId(unreadable[0]!)}: ` +
          `${removed.mediaServers} media server token(s), ${removed.watchSyncUsers} watch sync user token(s), ${removed.arrInstances} Radarr or Sonarr API key(s). ` +
          `Enter them again in Settings, and remove SRTL_DISCARD_UNREADABLE_CREDENTIALS.`
        );
      }
      await writeKeyCheck(client, box, options.timestamp);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}
