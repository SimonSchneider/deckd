import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "../src/bundle.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "deckd-bundle-test-"));
}

function writeManifest(dir: string, manifest: unknown): void {
  writeFileSync(join(dir, "deckd.json"), JSON.stringify(manifest));
}

describe("loadBundle", () => {
  it("loads a good bundle with theme, assets, examples, and guide, resolving absolute paths", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "logo.svg"), "<svg/>");
    mkdirSync(join(dir, "presentations", "example-deck"), { recursive: true });
    writeFileSync(join(dir, "presentations", "example-deck", "slides.md"), "# Example");
    writeFileSync(join(dir, "CLAUDE.md"), "# Guide");
    writeManifest(dir, { theme: "theme.css", assets: "assets", examples: "presentations", guide: "CLAUDE.md" });

    const bundle = loadBundle(dir);

    expect(bundle.dir).toBe(dir);
    expect(bundle.themeCss).toBe(join(dir, "theme.css"));
    expect(bundle.assetsDir).toBe(join(dir, "assets"));
    expect(bundle.examplesDir).toBe(join(dir, "presentations"));
    expect(bundle.guidePath).toBe(join(dir, "CLAUDE.md"));
  });

  it("resolves entries nested in subdirectories", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "themes"), { recursive: true });
    writeFileSync(join(dir, "themes", "brand.css"), "/* theme */");
    writeManifest(dir, { theme: "themes/brand.css" });

    const bundle = loadBundle(dir);

    expect(bundle.themeCss).toBe(join(dir, "themes", "brand.css"));
  });

  it("treats absent optional entries as the feature being absent, not an error", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    writeManifest(dir, { theme: "theme.css" });

    const bundle = loadBundle(dir);

    expect(bundle.assetsDir).toBeUndefined();
    expect(bundle.examplesDir).toBeUndefined();
    expect(bundle.guidePath).toBeUndefined();
  });

  it("throws clearly when the manifest file is missing", () => {
    const dir = makeDir();
    expect(() => loadBundle(dir)).toThrow(/manifest not found/);
  });

  it("throws clearly when the manifest is not valid JSON", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "deckd.json"), "{not json");
    expect(() => loadBundle(dir)).toThrow(/not valid JSON/);
  });

  it("throws clearly when the manifest is missing the required theme path", () => {
    const dir = makeDir();
    writeManifest(dir, { assets: "assets" });
    expect(() => loadBundle(dir)).toThrow(/required "theme"/);
  });

  it("throws clearly when the declared theme file does not exist", () => {
    const dir = makeDir();
    writeManifest(dir, { theme: "theme.css" });
    expect(() => loadBundle(dir)).toThrow(/theme.*not found/);
  });

  it("throws clearly when a declared optional directory does not exist", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    writeManifest(dir, { theme: "theme.css", assets: "assets" });
    expect(() => loadBundle(dir)).toThrow(/assets.*not found/);
  });

  it("rejects a theme path containing a \"..\" traversal segment", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "evil.css"), "/* evil */");
    writeManifest(dir, { theme: "../" + outside.split("/").pop() + "/evil.css" });
    expect(() => loadBundle(dir)).toThrow(/must not contain "\.\."/);
  });

  it("rejects an absolute theme path", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    writeManifest(dir, { theme: "/etc/passwd" });
    expect(() => loadBundle(dir)).toThrow(/must be a relative path/);
  });

  it("rejects a symlinked deckd.json manifest itself, not just its declared entries", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    writeManifest(outside, { theme: "theme.css" });
    symlinkSync(join(outside, "deckd.json"), join(dir, "deckd.json"));
    expect(() => loadBundle(dir)).toThrow(/manifest must not be a symlink/);
  });

  it("rejects a theme entry that is itself a symlink", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "real-theme.css"), "/* real */");
    symlinkSync(join(outside, "real-theme.css"), join(dir, "theme.css"));
    writeManifest(dir, { theme: "theme.css" });
    expect(() => loadBundle(dir)).toThrow(/must not be or contain a symlink/);
  });

  it("rejects an assets entry that is itself a symlink", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    const outsideAssets = makeDir();
    writeFileSync(join(outsideAssets, "logo.svg"), "<svg/>");
    symlinkSync(outsideAssets, join(dir, "assets"));
    writeManifest(dir, { theme: "theme.css", assets: "assets" });
    expect(() => loadBundle(dir)).toThrow(/must not be or contain a symlink/);
  });

  it("rejects a symlinked intermediate directory in a nested manifest path", () => {
    const dir = makeDir();
    const outsideThemes = makeDir();
    writeFileSync(join(outsideThemes, "brand.css"), "/* theme */");
    symlinkSync(outsideThemes, join(dir, "themes"));
    writeManifest(dir, { theme: "themes/brand.css" });
    expect(() => loadBundle(dir)).toThrow(/must not be or contain a symlink/);
  });

  it("throws clearly when a declared optional file (guide) does not exist", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    writeManifest(dir, { theme: "theme.css", guide: "CLAUDE.md" });
    expect(() => loadBundle(dir)).toThrow(/guide.*not found/);
  });

  it("throws when the theme path points at a directory instead of a file", () => {
    const dir = makeDir();
    mkdirSync(join(dir, "theme.css"));
    writeManifest(dir, { theme: "theme.css" });
    expect(() => loadBundle(dir)).toThrow(/theme.*not found/);
  });
});

describe("loadBundle render config", () => {
  function bundleDirWithTheme(): string {
    const dir = makeDir();
    writeFileSync(join(dir, "theme.css"), "/* theme */");
    return dir;
  }

  it("defaults to imageScale 2, pdfOutlines false, pdfNotes false when no render block is given", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css" });

    const bundle = loadBundle(dir);

    expect(bundle.render).toEqual({ imageScale: 2, pdfOutlines: false, pdfNotes: false });
  });

  it("applies a fully-specified render block", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: 3, pdfOutlines: true, pdfNotes: true } });

    const bundle = loadBundle(dir);

    expect(bundle.render).toEqual({ imageScale: 3, pdfOutlines: true, pdfNotes: true });
  });

  it("defaults any key omitted from a partial render block", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { pdfOutlines: true } });

    const bundle = loadBundle(dir);

    expect(bundle.render).toEqual({ imageScale: 2, pdfOutlines: true, pdfNotes: false });
  });

  it("rejects a render block that is not an object", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: "big" });
    expect(() => loadBundle(dir)).toThrow(/"render".*must be a JSON object/);
  });

  it("rejects an unknown key inside the render block (allowlist, not passthrough)", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScael: 3 } });
    expect(() => loadBundle(dir)).toThrow(/"render\.imageScael".*not a recognized key/);
  });

  it("rejects a non-numeric imageScale", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: "big" } });
    expect(() => loadBundle(dir)).toThrow(/"render\.imageScale".*number/);
  });

  it("rejects an imageScale below the 0.5 floor", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: 0.4 } });
    expect(() => loadBundle(dir)).toThrow(/"render\.imageScale".*between 0\.5 and 4/);
  });

  it("rejects an imageScale above the 4 ceiling", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: 4.5 } });
    expect(() => loadBundle(dir)).toThrow(/"render\.imageScale".*between 0\.5 and 4/);
  });

  it("accepts an imageScale exactly at the 0.5 floor", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: 0.5 } });
    expect(loadBundle(dir).render.imageScale).toBe(0.5);
  });

  it("accepts an imageScale exactly at the 4 ceiling", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { imageScale: 4 } });
    expect(loadBundle(dir).render.imageScale).toBe(4);
  });

  it("rejects an imageScale that overflows to Infinity", () => {
    const dir = bundleDirWithTheme();
    // 1e400 is valid JSON syntax, but overflows double precision on parse, so
    // JSON.parse itself hands back Infinity here -- the range check, not a
    // "not a number" check, is what must catch this.
    writeFileSync(join(dir, "deckd.json"), `{"theme":"theme.css","render":{"imageScale":1e400}}`);
    expect(() => loadBundle(dir)).toThrow(/"render\.imageScale".*between 0\.5 and 4/);
  });

  it("rejects a manifest that spells imageScale as a bare NaN literal", () => {
    const dir = bundleDirWithTheme();
    // NaN has no valid JSON spelling (JSON.parse never produces NaN for any
    // well-formed input), so a manifest that names it literally is invalid JSON,
    // not silently coerced into some finite number.
    writeFileSync(join(dir, "deckd.json"), `{"theme":"theme.css","render":{"imageScale":NaN}}`);
    expect(() => loadBundle(dir)).toThrow(/not valid JSON/);
  });

  it("rejects a non-boolean pdfOutlines", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { pdfOutlines: "yes" } });
    expect(() => loadBundle(dir)).toThrow(/"render\.pdfOutlines".*boolean/);
  });

  it("rejects a non-boolean pdfNotes", () => {
    const dir = bundleDirWithTheme();
    writeManifest(dir, { theme: "theme.css", render: { pdfNotes: 1 } });
    expect(() => loadBundle(dir)).toThrow(/"render\.pdfNotes".*boolean/);
  });
});
