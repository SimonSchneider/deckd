// Manual, non-vitest proof that createHostRenderer().renderPreviews produces real
// per-slide PNGs against a real bundle. Not part of the test suite; run by hand
// (build a bundle first, e.g. with `deckd pack`, or point DECKD_BUNDLE_DIR at one
// you already have):
//   DECKD_BUNDLE_DIR=<bundle dir> DECKD_MANUAL_SCRATCH_DIR=<scratch dir> \
//     DECKD_MANUAL_DECK_DIR=<deck dir> npx tsx scripts/manual-preview-proof.mjs
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHostRenderer } from "../src/host-render.js";
import { loadBundle } from "../src/bundle.js";

function requiredEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`${name} is required -- see this script's header comment for how to set it`);
  }
  return v;
}

const bundle = loadBundle(requiredEnv("DECKD_BUNDLE_DIR"));
const scratchRoot = requiredEnv("DECKD_MANUAL_SCRATCH_DIR");
const deckDir = requiredEnv("DECKD_MANUAL_DECK_DIR");
const slug = "host-render-preview-proof";

const renderer = createHostRenderer({
  bundle,
  scratchRoot,
  log: (m) => console.log("[log]", m),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
});

const started = Date.now();
const result = await renderer.renderPreviews({ key: "manual-preview-proof", deckDir, slug, timeoutMs: 300_000 });
console.log("---");
console.log("code:", result.code, "durationMs:", Date.now() - started);
console.log("output (tail):");
console.log(result.output.slice(-4000));
console.log("---");
console.log("pngs returned:", result.pngs);

const previewDir = join(deckDir, "preview");
console.log("preview dir exists:", existsSync(previewDir));
if (existsSync(previewDir)) {
  for (const name of readdirSync(previewDir).sort()) {
    const p = join(previewDir, name);
    console.log(`  ${name}: ${statSync(p).size} bytes`);
  }
}
