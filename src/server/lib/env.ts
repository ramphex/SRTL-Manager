import fs from "node:fs";

export interface EnvSettings {
  SYMLINK_DIR?: string;
  SRTL_LOCATION_1_PATH?: string;
  SRTL_LOCATION_2_PATH?: string;
  SRTL_DATA_DIR?: string;
  SRTL_DATABASE_URL?: string;
  SRTL_POSTGRES_HOST?: string;
  SRTL_POSTGRES_PORT?: string;
  SRTL_POSTGRES_DB?: string;
  SRTL_POSTGRES_USER?: string;
  SRTL_POSTGRES_PASSWORD?: string;
  SRTL_HOST?: string;
  SRTL_PORT?: string;
  SRTL_WEB_PORT?: string;
  SRTL_WORKER_COUNT?: string;
  SRTL_ALLOWED_ORIGINS?: string;
  SRTL_COOKIE_SECURE?: string;
  SRTL_API_DOCS?: string;
  SRTL_AUTO_MIGRATE?: string;
  SRTL_TRUST_PROXY?: string;
  SRTL_WEB_ROOT?: string;
}

const supportedKeys = [
  "SYMLINK_DIR",
  "SRTL_LOCATION_1_PATH",
  "SRTL_LOCATION_2_PATH",
  "SRTL_DATA_DIR",
  "SRTL_DATABASE_URL",
  "SRTL_POSTGRES_HOST",
  "SRTL_POSTGRES_PORT",
  "SRTL_POSTGRES_DB",
  "SRTL_POSTGRES_USER",
  "SRTL_POSTGRES_PASSWORD",
  "SRTL_HOST",
  "SRTL_PORT",
  "SRTL_WEB_PORT",
  "SRTL_WORKER_COUNT",
  "SRTL_ALLOWED_ORIGINS",
  "SRTL_COOKIE_SECURE",
  "SRTL_API_DOCS",
  "SRTL_AUTO_MIGRATE",
  "SRTL_TRUST_PROXY",
  "SRTL_WEB_ROOT"
] as const;

export function parseEnvFile(content: string): EnvSettings {
  const values: EnvSettings = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as keyof EnvSettings;
    if (!supportedKeys.includes(key)) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readEnvFile(filePath: string): EnvSettings {
  if (!fs.existsSync(filePath)) return {};
  return parseEnvFile(fs.readFileSync(filePath, "utf8"));
}

export function readProcessEnvSettings(env: NodeJS.ProcessEnv = process.env): EnvSettings {
  const values: EnvSettings = {};
  for (const key of supportedKeys) {
    const value = env[key];
    if (value) values[key] = value;
  }
  return values;
}

export function mergeEnvSettings(...sources: EnvSettings[]): EnvSettings {
  return Object.assign({}, ...sources);
}
