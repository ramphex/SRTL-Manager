import { discardUnreadableCredentialsSetting, resolveDatabaseUrl, secretKeyOptions } from "./config";
import { openDatabase } from "./db/database";
import { loadAndInstallSecretKey } from "./lib/secretBox";

// Migration 26 seals stored credentials, so the key is loaded before any migration runs.
const secretKey = loadAndInstallSecretKey(secretKeyOptions());
if (secretKey.source === "generated") console.warn(`Created the secret key for stored credentials at ${secretKey.path}. Back it up separately from database backups.`);
const database = await openDatabase({ databaseUrl: resolveDatabaseUrl(), migrate: true, discardUnreadableCredentials: discardUnreadableCredentialsSetting() });
await database.close();
