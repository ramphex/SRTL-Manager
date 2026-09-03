import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const clientRoot = "dist/client";
const serviceWorkerPath = path.join(clientRoot, "service-worker.js");
const buildRevisionToken = '"__SRTL_BUILD_REVISION__"';
const generatedAssetsToken = "/* __SRTL_GENERATED_ASSETS__ */ []";

async function collectClientFiles(directory, relativeDirectory = "") {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await collectClientFiles(directory, relativePath));
    else if (entry.isFile() && relativePath !== "service-worker.js") files.push(relativePath);
  }
  return files.sort();
}

async function stampServiceWorker() {
  const files = await collectClientFiles(clientRoot);
  const revisionHash = createHash("sha256");
  for (const relativePath of files) {
    revisionHash.update(relativePath);
    revisionHash.update(await readFile(path.join(clientRoot, relativePath)));
  }
  const revision = revisionHash.digest("hex").slice(0, 16);
  const assetUrls = files.filter((relativePath) => relativePath.startsWith(`assets${path.sep}`)).map((relativePath) => `/${relativePath.split(path.sep).join("/")}`);
  const source = await readFile(serviceWorkerPath, "utf8");
  if (!source.includes(buildRevisionToken) || !source.includes(generatedAssetsToken)) {
    throw new Error("Service worker build placeholders are missing.");
  }
  await writeFile(
    serviceWorkerPath,
    source.replace(buildRevisionToken, JSON.stringify(revision)).replace(generatedAssetsToken, JSON.stringify(assetUrls))
  );
}

await rm("dist", { recursive: true, force: true });
await viteBuild();
await stampServiceWorker();
await esbuild({
  entryPoints: ["src/server/index.ts", "src/server/worker.ts", "src/server/migrate.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist/server",
  sourcemap: true,
  logLevel: "info"
});
