// Manual, non-vitest proof that createHostRenderer produces a real PDF against a
// real bundle. Not part of the test suite; run by hand (build a bundle first,
// e.g. with `deckd pack`, or point DECKD_BUNDLE_DIR at one you already have):
//   DECKD_BUNDLE_DIR=<bundle dir> DECKD_MANUAL_SCRATCH_DIR=<scratch dir> \
//     DECKD_MANUAL_DECK_DIR=<deck dir> node scripts/manual-host-render-proof.mjs
import { existsSync } from "node:fs";
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
const slug = "host-render-proof";

const renderer = createHostRenderer({
  bundle,
  scratchRoot,
  log: (m) => console.log("[log]", m),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
});

const started = Date.now();
const result = await renderer.render({ key: "manual-proof", deckDir, slug, pptx: false, timeoutMs: 300_000 });
console.log("---");
console.log("code:", result.code, "durationMs:", Date.now() - started);
console.log("output (tail):");
console.log(result.output.slice(-4000));
console.log("---");
console.log("pdf produced:", existsSync(`${deckDir}/${slug}.pdf`));
console.log("charts.py sentinel exists (should be false):", existsSync(`${deckDir}/CHARTS_PY_EXECUTED`));
