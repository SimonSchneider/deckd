import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundleRef, loadBundle, type Bundle } from "../src/bundle.js";
import type { Config } from "../src/config.js";
import {
  installBundleZip, applyBundleEdit, swapBundleDir, bundleSummary,
  MAX_BUNDLE_FILE_BYTES, MAX_BUNDLE_TOTAL_BYTES,
} from "../src/bundle-upload.js";
import { zipBundleDir } from "../src/bundle-pack.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A placeholder Bundle to seed a BundleRef with before installBundleZip replaces it
// -- its own fields are only ever read by tests asserting a *failed* install left
// the ref untouched, so themeCss need not exist on disk.
function placeholderBundle(dir: string): Bundle {
  return { dir, themeCss: join(dir, "theme.css"), render: { imageScale: 2, pdfOutlines: false, pdfNotes: false } };
}

// A fresh, empty "data dir" per test, so cfg.bundleDir's parent is real and writable
// (installBundleZip extracts a sibling of cfg.bundleDir, then renames it in --
// see bundle-upload.ts's swapBundleDir comment on why it must share a filesystem).
function makeCfg(): Config {
  const dataDir = scratchDir("deckd-bundle-upload-data-");
  return {
    port: 0, dbPath: ":memory:", devUser: "dev@example.com",
    bundleDir: join(dataDir, "bundle"),
    scratchDir: join(dataDir, "render-scratch"),
    canonicalCacheDir: join(dataDir, "canonical-cache"),
    localDecksRoot: join(dataDir, "local-decks"),
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
}

function zipDir(srcDir: string): Buffer {
  const zipPath = join(scratchDir("deckd-bundle-upload-zip-"), "bundle.zip");
  execFileSync("zip", ["-r", zipPath, "."], { cwd: srcDir });
  return readFileSync(zipPath);
}

// Populates an already-existing directory with a theme, an assets dir, and one
// example deck -- the shape most upload tests start from. Factored out from
// makeGoodBundleTree below so a wrapper-zip test can build this content INSIDE a
// wrapper directory of its own choosing, rather than at a fresh scratchDir's own root.
function makeGoodBundleTreeAt(dir: string, themeMarker = "good-theme-v1"): void {
  writeFileSync(join(dir, "theme.css"), `/* ${themeMarker} */\nsection { background: white; }\n`);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "logo.svg"), "<svg/>");
  mkdirSync(join(dir, "presentations", "example-deck"), { recursive: true });
  writeFileSync(join(dir, "presentations", "example-deck", "slides.md"), "# Example\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# Guide\n");
  writeFileSync(
    join(dir, "deckd.json"),
    JSON.stringify({ theme: "theme.css", assets: "assets", examples: "presentations", guide: "CLAUDE.md" }),
  );
}

// Builds a valid, on-disk bundle source tree (not yet zipped) at a fresh scratchDir's
// own root.
function makeGoodBundleTree(themeMarker = "good-theme-v1"): string {
  const dir = scratchDir("deckd-bundle-upload-src-");
  makeGoodBundleTreeAt(dir, themeMarker);
  return dir;
}

describe("installBundleZip", () => {
  it("extracts, validates, and swaps a good zip into cfg.bundleDir, updating bundleRef", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("old-theme"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const zipBytes = zipDir(makeGoodBundleTree("new-theme"));
    const { bundle, summary } = await installBundleZip(zipBytes, cfg, bundleRef);

    expect(bundle.dir).toBe(cfg.bundleDir);
    expect(readFileSync(bundle.themeCss, "utf8")).toContain("new-theme");
    expect(bundleRef.current().dir).toBe(cfg.bundleDir);
    expect(bundleRef.current().themeCss).toBe(bundle.themeCss);
    expect(summary.manifest).toEqual({ theme: "theme.css", assets: "assets", examples: "presentations", guide: "CLAUDE.md" });
    expect(summary.exampleCount).toBe(1);
    expect(summary.fileCount).toBeGreaterThan(0);
    expect(summary.uploadedAt).toBeGreaterThan(0);
  });

  // The render block is just manifest JSON, so it round-trips through the exact same
  // path every other manifest key does: no dedicated (de)serialization to keep in
  // sync. Exercised through zipBundleDir (download's own zip path) rather than the
  // `zip` CLI zipDir() helper above, so both of a bundle's real zip producers are
  // covered somewhere in this suite.
  it("preserves the manifest's render block through a zipBundleDir download re-installed via installBundleZip", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const sourceDir = makeGoodBundleTree();
    writeFileSync(
      join(sourceDir, "deckd.json"),
      JSON.stringify({
        theme: "theme.css",
        assets: "assets",
        examples: "presentations",
        guide: "CLAUDE.md",
        render: { imageScale: 3, pdfOutlines: true, pdfNotes: true },
      }),
    );

    const downloadPath = join(scratchDir("deckd-bundle-upload-download-"), "bundle.zip");
    await zipBundleDir(sourceDir, downloadPath);

    const { bundle, summary } = await installBundleZip(readFileSync(downloadPath), cfg, bundleRef);

    expect(bundle.render).toEqual({ imageScale: 3, pdfOutlines: true, pdfNotes: true });
    expect(summary.manifest.render).toEqual({ imageScale: 3, pdfOutlines: true, pdfNotes: true });
  });

  it("leaves the current bundle untouched when the zip has no deckd.json", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("kept-theme"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const badDir = scratchDir("deckd-bundle-upload-nomanifest-");
    writeFileSync(join(badDir, "theme.css"), "/* no manifest */");
    const zipBytes = zipDir(badDir);

    await expect(installBundleZip(zipBytes, cfg, bundleRef)).rejects.toThrow(/manifest not found/);
    expect(readFileSync(join(cfg.bundleDir, "theme.css"), "utf8")).toContain("kept-theme");
    expect(bundleRef.current().dir).toBe(cfg.bundleDir);
  });

  it("gives a friendlier hint (zip root or single wrapper folder) than a bare manifest-not-found", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const badDir = scratchDir("deckd-bundle-upload-nomanifest-hint-");
    writeFileSync(join(badDir, "theme.css"), "/* no manifest */");

    await expect(installBundleZip(zipDir(badDir), cfg, bundleRef)).rejects.toThrow(/wrapper folder/);
  });

  // Regression: zipping a FOLDER rather than its contents (Finder's default, and a
  // plain `zip -r out.zip my-folder`) wraps every entry in one extra directory, so
  // deckd.json ends up at <root>/my-bundle/deckd.json instead of at the zip root.
  it("installs a bundle zipped as a single wrapper folder (Finder's default), stripping junk mixed in around it", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const parent = scratchDir("deckd-bundle-upload-wrapper-parent-");
    const wrapperDir = join(parent, "my-bundle");
    mkdirSync(wrapperDir, { recursive: true });
    makeGoodBundleTreeAt(wrapperDir, "wrapped-theme");
    // Nested junk inside the wrapper, and a __MACOSX sibling tree alongside it --
    // both of which stripOsJunk must clear before the single-wrapper heuristic runs,
    // or __MACOSX as a second top-level entry would make this look ambiguous.
    writeFileSync(join(wrapperDir, ".DS_Store"), "junk");
    mkdirSync(join(parent, "__MACOSX", "my-bundle"), { recursive: true });
    writeFileSync(join(parent, "__MACOSX", "my-bundle", "._deckd.json"), "junk");

    const zipPath = join(scratchDir("deckd-bundle-upload-wrapper-out-"), "bundle.zip");
    execFileSync("zip", ["-r", zipPath, "my-bundle", "__MACOSX"], { cwd: parent });

    const { bundle } = await installBundleZip(readFileSync(zipPath), cfg, bundleRef);

    expect(readFileSync(bundle.themeCss, "utf8")).toContain("wrapped-theme");
    expect(existsSync(join(bundle.dir, "deckd.json"))).toBe(true);
    // The wrapper directory itself must not survive as a subdirectory of the bundle.
    expect(existsSync(join(bundle.dir, "my-bundle"))).toBe(false);
    expect(existsSync(join(bundle.dir, "__MACOSX"))).toBe(false);
    expect(existsSync(join(bundle.dir, ".DS_Store"))).toBe(false);
  });

  it("errors clearly when the single top-level directory has no deckd.json at its root", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const parent = scratchDir("deckd-bundle-upload-nomanifest-wrapper-parent-");
    const wrapperDir = join(parent, "not-a-bundle");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "readme.txt"), "nothing to see here");

    const zipPath = join(scratchDir("deckd-bundle-upload-nomanifest-wrapper-out-"), "bundle.zip");
    execFileSync("zip", ["-r", zipPath, "not-a-bundle"], { cwd: parent });

    await expect(installBundleZip(readFileSync(zipPath), cfg, bundleRef)).rejects.toThrow(/manifest not found/);
  });

  // No guessing: two top-level directories, neither with a manifest at the zip root,
  // must never be resolved by picking one arbitrarily.
  it("refuses to guess between two top-level directories when neither is a root manifest", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));

    const parent = scratchDir("deckd-bundle-upload-ambiguous-parent-");
    mkdirSync(join(parent, "bundle-a"), { recursive: true });
    mkdirSync(join(parent, "bundle-b"), { recursive: true });
    makeGoodBundleTreeAt(join(parent, "bundle-a"), "a-theme");
    makeGoodBundleTreeAt(join(parent, "bundle-b"), "b-theme");

    const zipPath = join(scratchDir("deckd-bundle-upload-ambiguous-out-"), "bundle.zip");
    execFileSync("zip", ["-r", zipPath, "bundle-a", "bundle-b"], { cwd: parent });

    await expect(installBundleZip(readFileSync(zipPath), cfg, bundleRef)).rejects.toThrow(/manifest not found/);
  });

  it("rejects a disallowed file extension and names the offending file", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/run\.sh/);
  });

  it("rejects a no-extension file (would-be shebang-less executable)", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "Makefile"), "all:\n\techo hi\n");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/Makefile/);
  });

  it("rejects a python or html file even without the executable bit set", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "build.py"), "print('hi')\n");
    writeFileSync(join(dir, "index.html"), "<html></html>");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/build\.py|index\.html/);
  });

  it("rejects a disallowed extension regardless of case", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "build.PY"), "print('hi')\n");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/build\.PY/);
  });

  it("rejects a double-extension file by its actual last extension", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "a.css.py"), "print('hi')\n");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/a\.css\.py/);
  });

  it("rejects a dotfile as a no-extension file, same as a shebang-less executable", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/\.gitignore/);
  });

  it("strips macOS/Windows zip-tool junk before validation, instead of rejecting the upload for it", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    mkdirSync(join(dir, "__MACOSX"), { recursive: true });
    writeFileSync(join(dir, "__MACOSX", "._deckd-bundle"), "junk");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    writeFileSync(join(dir, "assets", "Thumbs.db"), "junk");

    const { bundle } = await installBundleZip(zipDir(dir), cfg, bundleRef);

    expect(existsSync(bundle.themeCss)).toBe(true);
    expect(existsSync(join(bundle.dir, "__MACOSX"))).toBe(false);
    expect(existsSync(join(bundle.dir, ".DS_Store"))).toBe(false);
    expect(existsSync(join(bundle.dir, "assets", "Thumbs.db"))).toBe(false);
  });

  it("rejects a single file over the per-file size cap", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    writeFileSync(join(dir, "assets", "huge.png"), Buffer.alloc(MAX_BUNDLE_FILE_BYTES + 1));

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/huge\.png/);
  });

  it("rejects a bundle whose total decoded size exceeds the total cap", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const dir = makeGoodBundleTree();
    // Six files, each just under the per-file cap, comfortably summing past the
    // (smaller) total cap while no single file trips the per-file check instead.
    const perFile = MAX_BUNDLE_FILE_BYTES - 1024;
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, "assets", `pad-${i}.png`), Buffer.alloc(perFile));
    }

    await expect(installBundleZip(zipDir(dir), cfg, bundleRef)).rejects.toThrow(/total decoded size cap/);
  });

  it("rejects a high-compression-ratio zip mid-extraction and leaves nothing on disk", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const scratch = scratchDir("deckd-bundle-upload-zipbomb-");
    const zipPath = join(scratch, "bomb.zip");
    // 200MB of zeros compresses down to a few hundred bytes -- the zip on disk is
    // tiny, but decompressing "assets/huge.bin" alone would blow past both caps if
    // nothing checked the real bytes streaming off the decompressor.
    execFileSync("python3", [
      "-c",
      `
import zipfile
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w", zipfile.ZIP_DEFLATED)
zf.writestr("deckd.json", '{"theme": "theme.css"}')
zf.writestr("theme.css", "/* theme */")
zf.writestr("assets/huge.bin", b"\\0" * (200 * 1024 * 1024))
zf.close()
`,
    ]);

    await expect(installBundleZip(readFileSync(zipPath), cfg, bundleRef)).rejects.toThrow(/exceeds the per-file cap/);
    expect(existsSync(cfg.bundleDir)).toBe(false);
    const dataDirParent = join(cfg.bundleDir, "..");
    expect(readdirSync(dataDirParent).filter((e) => e.startsWith("bundle.incoming-"))).toEqual([]);
  });

  it("rejects a zip-slip entry before extraction touches the live bundle", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const scratch = scratchDir("deckd-bundle-upload-zipslip-");
    const zipPath = join(scratch, "evil.zip");
    execFileSync("python3", [
      "-c",
      `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}, "w").writestr("../evil.txt", "x")`,
    ]);

    await expect(installBundleZip(readFileSync(zipPath), cfg, bundleRef)).rejects.toThrow(/unsafe zip entry/);
    expect(existsSync(join(cfg.bundleDir, "..", "evil.txt"))).toBe(false);
  });

  it("strips a symlink entry from the upload instead of installing it", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const scratch = scratchDir("deckd-bundle-upload-symlink-");
    const zipPath = join(scratch, "evil-link.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile, stat
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
zf.writestr("theme.css", "/* theme */")
zf.writestr("deckd.json", '{"theme": "theme.css"}')
info = zipfile.ZipInfo("secret")
info.create_system = 3
info.external_attr = (stat.S_IFLNK | 0o777) << 16
zf.writestr(info, "/etc/passwd")
zf.close()
`,
    ]);

    const { bundle } = await installBundleZip(readFileSync(zipPath), cfg, bundleRef);
    expect(existsSync(join(bundle.dir, "secret"))).toBe(false);
    expect(existsSync(bundle.themeCss)).toBe(true);
  });

  it("cleans up its tmpdir()-side working directory on both success and failure", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const before = new Set(readdirSync(tmpdir()));

    await installBundleZip(zipDir(makeGoodBundleTree()), cfg, bundleRef);
    const badDir = makeGoodBundleTree();
    writeFileSync(join(badDir, "run.sh"), "#!/bin/sh\n");
    await expect(installBundleZip(zipDir(badDir), cfg, bundleRef)).rejects.toThrow();

    const leftover = readdirSync(tmpdir()).filter((n) => !before.has(n) && n.startsWith("deckd-bundle-zip-work-"));
    expect(leftover).toEqual([]);
  });
});

describe("swapBundleDir", () => {
  it("renames the incoming dir into bundleDir and removes the old one", () => {
    const dataDir = scratchDir("deckd-swap-data-");
    const bundleDir = join(dataDir, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "marker.txt"), "old");
    const incoming = join(dataDir, "bundle.incoming-1");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "deckd.json"), JSON.stringify({ theme: "theme.css" }));
    writeFileSync(join(incoming, "theme.css"), "/* new */");

    const bundle = swapBundleDir(bundleDir, incoming);

    expect(bundle.dir).toBe(bundleDir);
    expect(existsSync(join(bundleDir, "theme.css"))).toBe(true);
    expect(existsSync(join(bundleDir, "marker.txt"))).toBe(false);
    expect(existsSync(incoming)).toBe(false);
  });

  it("restores the old bundle when the second rename fails", () => {
    const dataDir = scratchDir("deckd-swap-fail-data-");
    const bundleDir = join(dataDir, "bundle");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "marker.txt"), "still-here");
    const missingIncoming = join(dataDir, "bundle.incoming-does-not-exist");

    expect(() => swapBundleDir(bundleDir, missingIncoming)).toThrow();
    expect(existsSync(bundleDir)).toBe(true);
    expect(existsSync(join(bundleDir, "marker.txt"))).toBe(true);
    // No leftover ".stale-" directory from the failed attempt.
    expect(readdirSync(dataDir)).toEqual(["bundle"]);
  });

  it("works when there is no pre-existing bundleDir (first install)", () => {
    const dataDir = scratchDir("deckd-swap-first-data-");
    const bundleDir = join(dataDir, "bundle");
    const incoming = join(dataDir, "bundle.incoming-1");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "deckd.json"), JSON.stringify({ theme: "theme.css" }));
    writeFileSync(join(incoming, "theme.css"), "/* first */");

    const bundle = swapBundleDir(bundleDir, incoming);

    expect(bundle.dir).toBe(bundleDir);
    expect(existsSync(join(bundleDir, "theme.css"))).toBe(true);
  });
});

describe("bundleSummary", () => {
  it("reports the manifest, file/example counts, and the uploadedAt marker installBundleZip wrote", async () => {
    const cfg = makeCfg();
    const bundleRef = createBundleRef(placeholderBundle(cfg.bundleDir));
    const { bundle, summary } = await installBundleZip(zipDir(makeGoodBundleTree()), cfg, bundleRef);

    expect(bundleSummary(bundle)).toEqual(summary);
  });

  it("falls back to deckd.json's mtime when no uploadedAt marker exists yet (a hand-seeded bundle)", () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("hand-seeded"), cfg.bundleDir, { recursive: true });
    const bundle = loadBundle(cfg.bundleDir);

    const summary = bundleSummary(bundle);

    expect(summary.uploadedAt).toBeGreaterThan(0);
  });
});

describe("applyBundleEdit", () => {
  it("applies a synchronous mutation via the same stage-validate-swap installBundleZip uses", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("v1"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));

    const { bundle } = await applyBundleEdit(cfg, bundleRef, (stagingDir) => {
      writeFileSync(join(stagingDir, "theme.css"), "/* v2 */\n");
    });

    expect(readFileSync(bundle.themeCss, "utf8")).toContain("v2");
    expect(bundleRef.current().dir).toBe(cfg.bundleDir);
  });

  it("rejects an async mutate callback instead of validating/swapping a staging dir it hasn't finished writing to", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("v1"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));

    await expect(
      applyBundleEdit(cfg, bundleRef, async (stagingDir) => {
        writeFileSync(join(stagingDir, "theme.css"), "/* should never apply */\n");
      }),
    ).rejects.toThrow(/synchronous/);

    expect(readFileSync(bundleRef.current().themeCss, "utf8")).toContain("v1");
  });

  it("rewrites a manifest-break error to the bundle-relative path, not the staging temp dir", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("v1"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));

    let caught: Error | null = null;
    try {
      await applyBundleEdit(cfg, bundleRef, (stagingDir) => {
        writeFileSync(join(stagingDir, "deckd.json"), JSON.stringify({ theme: "does-not-exist.css" }));
      });
    } catch (e: unknown) {
      caught = e instanceof Error ? e : new Error(String(e));
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/theme/);
    expect(caught?.message).toMatch(/does-not-exist\.css/);
    expect(caught?.message).not.toContain(cfg.bundleDir);
    expect(caught?.message).not.toMatch(/bundle\.edit-/);
  });

  // Regression: applyBundleEdit previously touched deckd.json's own mtime on every
  // edit (via markUploaded), so an unrelated write_bundle_file("theme.css") made a
  // client's earlier read of deckd.json's mtime look stale for a LATER write to
  // deckd.json itself, even though deckd.json's content never changed in between.
  it("does not bump deckd.json's own mtime when an unrelated file is the one being edited", async () => {
    const cfg = makeCfg();
    cpSync(makeGoodBundleTree("v1"), cfg.bundleDir, { recursive: true });
    const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));

    const manifestPath = join(cfg.bundleDir, "deckd.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const baseMtime = statSync(manifestPath).mtimeMs;

    // An edit to a different file must not meaningfully touch deckd.json's mtime --
    // within the same sub-millisecond tolerance every base_mtime check in this
    // codebase already applies, not necessarily bit-for-bit (the staging copy's
    // mtime preservation round-trips through fractional seconds, see
    // copyDirSkippingSymlinks).
    await applyBundleEdit(cfg, bundleRef, (stagingDir) => {
      writeFileSync(join(stagingDir, "theme.css"), "/* v2 */\n");
    });
    expect(Math.abs(statSync(manifestPath).mtimeMs - baseMtime)).toBeLessThanOrEqual(1);

    // A write to deckd.json itself, based on the ORIGINAL mtime read above, must
    // still succeed -- it was never actually invalidated by the unrelated edit.
    const outcome = await applyBundleEdit(cfg, bundleRef, (stagingDir) => {
      const current = statSync(join(stagingDir, "deckd.json")).mtimeMs;
      if (Math.abs(current - baseMtime) > 1) throw new Error("false conflict: deckd.json mtime moved from an unrelated edit");
      writeFileSync(join(stagingDir, "deckd.json"), originalManifest);
    });

    expect(outcome.bundle.dir).toBe(cfg.bundleDir);
  });
});
