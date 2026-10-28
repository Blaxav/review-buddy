// Bundles the extension into extension/dist, the folder Safari's converter wraps
// and Chrome loads unpacked.
import { cpSync, rmSync } from "node:fs";
import { loadToken } from "../helper/config";

const outdir = "extension/dist";
rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["extension/src/background.ts", "extension/src/content.ts"],
  outdir,
  target: "browser",
  format: "iife",
  minify: false,
  // The helper's token goes into the build, so there is nothing to paste: the
  // extension is built on the machine that runs the helper.
  define: { HELPER_TOKEN: JSON.stringify(loadToken()) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
cpSync("extension/manifest.json", `${outdir}/manifest.json`);
cpSync("extension/icons", `${outdir}/icons`, { recursive: true });
console.log(`Built ${result.outputs.length} files into ${outdir}`);
