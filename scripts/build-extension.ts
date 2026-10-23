// Bundles the extension into extension/dist, the folder Safari's converter wraps.
import { cpSync, rmSync } from "node:fs";

const outdir = "extension/dist";
rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["extension/src/background.ts", "extension/src/content.ts"],
  outdir,
  target: "browser",
  format: "iife",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync("extension/manifest.json", `${outdir}/manifest.json`);
console.log(`Built ${result.outputs.length} files into ${outdir}`);
