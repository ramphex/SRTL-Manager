import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Temporary folders live here because a backup location may not be inside /tmp, and the folder is already ignored by git. */
export const backupTestRoot = path.resolve("node_modules/.cache/srtl-backup-tests");
const dockerImage = process.env.SRTL_TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";

export async function makeBackupTestDir(): Promise<string> {
  await fs.mkdir(backupTestRoot, { recursive: true });
  return fs.mkdtemp(path.join(backupTestRoot, "run-"));
}

async function hasPostgresClient(tool: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(tool, ["--version"]);
    return Number(/(\d+)/.exec(stdout)?.[1]) >= 17;
  } catch {
    return false;
  }
}

function wrapperScript(tool: string): string {
  const macHost = os.platform() === "darwin";
  return `#!/bin/sh
export HOME=${JSON.stringify(os.homedir())}
export PATH=${JSON.stringify(process.env.PATH ?? "")}
host="$PGHOST"
network="--network=host"
${macHost ? 'network=""\ncase "$host" in 127.0.0.1|localhost) host=host.docker.internal ;; esac' : ""}
exec docker run --rm -i $network --user "$(id -u):$(id -g)" \\
  -v ${JSON.stringify(`${backupTestRoot}:${backupTestRoot}`)} \\
  -e PGHOST="$host" -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD -e PGAPPNAME -e LC_ALL \\
  --entrypoint ${tool} ${dockerImage} "$@"
`;
}

/**
 * The folder holding a real pg_dump and pg_restore of version 17 or newer. It
 * prefers SRTL_TEST_PG_BIN_DIR, then PATH, and otherwise wraps the same image
 * the test database uses, so this runs on a machine without a matching client.
 */
export async function realPostgresClient(): Promise<string | null> {
  if (process.env.SRTL_TEST_PG_BIN_DIR) return process.env.SRTL_TEST_PG_BIN_DIR;
  if ((await hasPostgresClient("pg_dump")) && (await hasPostgresClient("pg_restore"))) return null;
  await fs.mkdir(backupTestRoot, { recursive: true });
  const wrapperDir = await fs.mkdtemp(path.join(backupTestRoot, "client-"));
  for (const tool of ["pg_dump", "pg_restore"]) {
    await fs.writeFile(path.join(wrapperDir, tool), wrapperScript(tool), { mode: 0o755 });
  }
  return wrapperDir;
}
