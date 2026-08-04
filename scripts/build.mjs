import { rm } from "node:fs/promises";
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

await rm("dist", { recursive: true, force: true });
await viteBuild();
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
