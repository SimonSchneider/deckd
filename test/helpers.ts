import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle, type Bundle } from "../src/bundle.js";

const SLIDES_MD = "---\nmarp: true\ntheme: sample\npaginate: true\ntitle: Template gallery\n---\n\n# Template gallery\n";

// A plain, empty deck app dir for tests to seed whatever presentations/<slug>
// they need on top of.
export function tmpAppDir(): string {
  return mkdtempSync(join(tmpdir(), "deckd-app-"));
}

// The exact guide-content marker tests look for when asserting read_guide surfaces
// the bundle's own guide file, unchanged.
export const GUIDE_MARKER = "# Deck Authoring Guide (fixture marker)";

export interface MakeBundleOptions {
  assets?: boolean;
  examples?: boolean;
  guide?: boolean;
}

// Builds a real, on-disk bundle directory (deckd.json + theme.css, and whichever
// optional entries are requested) and loads it through the real loadBundle, so
// every test consuming a Bundle exercises the same validated shape production code
// does. assets/examples/guide default to present; pass `false` to omit one and
// exercise the "feature absent" behavior.
export function makeBundle(opts: MakeBundleOptions = {}): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "deckd-bundle-"));
  writeFileSync(join(dir, "theme.css"), "/* @theme sample */\nsection { background: white; }\n");
  const manifest: Record<string, string> = { theme: "theme.css" };

  if (opts.assets !== false) {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "sample-logo-black.svg"), "<svg/>");
    manifest.assets = "assets";
  }
  if (opts.examples !== false) {
    mkdirSync(join(dir, "presentations", "template-gallery"), { recursive: true });
    writeFileSync(join(dir, "presentations", "template-gallery", "slides.md"), SLIDES_MD);
    manifest.examples = "presentations";
  }
  if (opts.guide !== false) {
    writeFileSync(join(dir, "CLAUDE.md"), `${GUIDE_MARKER}\n\nWrite decks like this.\n`);
    manifest.guide = "CLAUDE.md";
  }

  writeFileSync(join(dir, "deckd.json"), JSON.stringify(manifest));
  return loadBundle(dir);
}
