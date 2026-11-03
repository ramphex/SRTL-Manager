import fs from "node:fs";
import path from "node:path";
import { setupTokenFileName } from "../src/server/setupToken";

/** Reads the first-run setup token the app wrote to its data directory. */
export function readSetupToken(app: { config: { dataDir: string } }): string {
  return fs.readFileSync(path.join(app.config.dataDir, setupTokenFileName), "utf8").trim();
}
