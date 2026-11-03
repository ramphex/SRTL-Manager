// Encryption at rest for stored credentials: Plex tokens, Jellyfin API keys, and Radarr and Sonarr API keys.
//
// Values are sealed with AES-256-GCM as `enc:v1:<key id>:<iv>:<ciphertext>:<tag>` (base64url parts). The key id
// names the key that sealed a value, so a later key rotation can keep older keys for reading. The version, key id
// and the value's purpose are authenticated, so a value cannot be edited or moved to another field unnoticed.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const secretPrefix = "enc:v1:";
const keyBytes = 32;
const ivBytes = 12;
const tagBytes = 16;

/** What each sealed value is for. Part of the authenticated data. */
export const secretPurposes = {
  mediaServerToken: "media_servers.token",
  watchSyncUserToken: "watch_sync_users.access_token",
  radarrApiKey: "radarrInstances.apiKey",
  sonarrApiKey: "sonarrInstances.apiKey",
  keyCheck: "secret-key-check"
} as const;

export type SecretPurpose = (typeof secretPurposes)[keyof typeof secretPurposes];

export class SecretKeyError extends Error {}

/** A stored value was sealed with a key SRTL does not have. */
export class SecretKeyMismatchError extends SecretKeyError {
  constructor(readonly storedKeyId: string, readonly currentKeyId: string) {
    super(`A stored credential was encrypted with secret key ${storedKeyId}, but the configured secret key is ${currentKeyId}.`);
  }
}

/** A stored value failed authentication: it was changed, truncated, or moved from another field. */
export class SecretDecryptError extends SecretKeyError {
  constructor() {
    super("A stored credential could not be decrypted. It may have been modified.");
  }
}

// Every sealed format starts with "enc:". Tokens and API keys never contain a colon, so nothing stored in plaintext
// can be mistaken for one, and an altered version tag is rejected rather than read as plaintext.
const sealedMarker = "enc:";

export function isSealedSecret(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(sealedMarker);
}

/** A short, non-reversible name for a key, safe to show in logs and errors. */
export function secretKeyId(key: Buffer): string {
  return createHmac("sha256", key).update("srtl-secret-key-id").digest("hex").slice(0, 16);
}

function associatedData(keyId: string, purpose: SecretPurpose): Buffer {
  return Buffer.from(`srtl:v1:${keyId}:${purpose}`, "utf8");
}

/** Seals and opens values with one current key and, for rotation, any number of older keys used only for reading. */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  readonly keyId: string;

  constructor(primary: Buffer, previous: Buffer[] = []) {
    for (const key of [primary, ...previous]) {
      if (key.length !== keyBytes) throw new SecretKeyError(`Secret keys must be ${keyBytes} bytes.`);
      const id = secretKeyId(key);
      if (!this.keys.has(id)) this.keys.set(id, Buffer.from(key));
    }
    this.keyId = secretKeyId(primary);
  }

  seal(plaintext: string, purpose: SecretPurpose): string {
    const key = this.keys.get(this.keyId)!;
    const iv = randomBytes(ivBytes);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: tagBytes });
    cipher.setAAD(associatedData(this.keyId, purpose));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${secretPrefix}${this.keyId}:${iv.toString("base64url")}:${ciphertext.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
  }

  /** Opens a sealed value. Values stored before encryption existed are returned as they are. */
  open(value: string, purpose: SecretPurpose): string {
    if (!isSealedSecret(value)) return value;
    if (!value.startsWith(secretPrefix)) throw new SecretDecryptError();
    const parts = value.slice(secretPrefix.length).split(":");
    if (parts.length !== 4) throw new SecretDecryptError();
    const [keyId, ivText, ciphertextText, tagText] = parts as [string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new SecretKeyMismatchError(keyId, this.keyId);
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== ivBytes || tag.length !== tagBytes) throw new SecretDecryptError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: tagBytes });
      decipher.setAAD(associatedData(keyId, purpose));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretDecryptError();
    }
  }

  /** Whether a sealed value names a key this box holds. */
  canOpen(value: string): boolean {
    if (!isSealedSecret(value)) return true;
    return value.startsWith(secretPrefix) && this.keys.has(value.slice(secretPrefix.length).split(":", 1)[0] ?? "");
  }
}

// ---------------------------------------------------------------- the process-wide key

let active: SecretBox | null = null;

/** Installs the key every later read and write uses. Called once at startup, before the database opens. */
export function installSecretBox(box: SecretBox): void {
  active = box;
}

export function activeSecretBox(): SecretBox {
  if (!active) throw new SecretKeyError("The secret key for stored credentials is not loaded.");
  return active;
}

/** Seals a credential for storage. An empty value stays empty, meaning "not set". */
export function sealSecret(value: string, purpose: SecretPurpose): string {
  return value ? activeSecretBox().seal(value, purpose) : "";
}

export function openSecret(value: string, purpose: SecretPurpose): string;
export function openSecret(value: string | null, purpose: SecretPurpose): string | null;
export function openSecret(value: string | null, purpose: SecretPurpose): string | null {
  if (value === null || value === "") return value;
  return activeSecretBox().open(value, purpose);
}

// ---------------------------------------------------------------- loading the key

export const secretKeyFileName = "secret.key";
const keyHelp = "Generate one with: openssl rand -base64 32";

/** Accepts 32 bytes as base64, base64url or 64 hex characters. The value itself never appears in errors. */
export function parseSecretKey(text: string, source: string): Buffer {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (decoded.length === keyBytes) return decoded;
  }
  throw new SecretKeyError(`${source} must be 32 random bytes written as base64 or 64 hexadecimal characters. ${keyHelp}`);
}

export interface SecretKeyOptions {
  /** SRTL_SECRET_KEY. */
  key?: string | null;
  /** SRTL_SECRET_KEY_FILE: a file holding the key, such as a Docker secret. */
  keyFile?: string | null;
  /** Where the key file is created when neither setting is given. */
  dataDir: string;
  /** Directories whose contents do not survive a restart; no key is ever generated inside them. */
  temporaryDirs?: string[];
}

export interface LoadedSecretKey {
  box: SecretBox;
  source: "environment" | "file" | "generated";
  /** The key file, when the key came from one. */
  path: string | null;
}

function readKeyFile(file: string, label: string): Buffer {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SecretKeyError(`${label} ${file} could not be read (${code ?? "unknown error"}).`, { cause: error });
  }
  return parseSecretKey(text, `${label} ${file}`);
}

function insideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Creates the key file atomically: a fully written temporary file is linked into place, so a second process
// starting at the same moment either wins the race or reads the complete winner.
function generateKeyFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${randomBytes(keyBytes).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Finds the key for stored credentials: SRTL_SECRET_KEY, else SRTL_SECRET_KEY_FILE, else `secret.key` in the data
 * directory, which is created with mode 0600 on first start. A key is never generated in a temporary directory,
 * where it would be lost on restart along with every credential sealed with it.
 */
export function loadSecretKey(options: SecretKeyOptions): LoadedSecretKey {
  if (options.key?.trim()) return { box: new SecretBox(parseSecretKey(options.key, "SRTL_SECRET_KEY")), source: "environment", path: null };
  if (options.keyFile?.trim()) {
    const file = path.resolve(options.keyFile.trim());
    return { box: new SecretBox(readKeyFile(file, "SRTL_SECRET_KEY_FILE")), source: "file", path: file };
  }
  const file = path.join(options.dataDir, secretKeyFileName);
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) console.warn(`The secret key file ${file} is readable by other users (mode ${mode.toString(8)}). Restrict it with: chmod 600 ${file}`);
    return { box: new SecretBox(readKeyFile(file, "The secret key file")), source: "file", path: file };
  }
  const temporaryDirs = options.temporaryDirs ?? [os.tmpdir(), "/tmp"];
  if (temporaryDirs.some((directory) => insideDirectory(file, directory))) {
    throw new SecretKeyError(
      `SRTL_SECRET_KEY is not set, and the data directory ${options.dataDir} is temporary, so a generated key would be lost on restart and the stored credentials with it. Set SRTL_SECRET_KEY in .env. ${keyHelp}`
    );
  }
  generateKeyFile(file);
  return { box: new SecretBox(readKeyFile(file, "The secret key file")), source: "generated", path: file };
}

/** Loads the key and makes it the process-wide key. */
export function loadAndInstallSecretKey(options: SecretKeyOptions): LoadedSecretKey {
  const loaded = loadSecretKey(options);
  installSecretBox(loaded.box);
  return loaded;
}
