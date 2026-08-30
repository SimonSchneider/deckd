import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packBundle, zipBundleDir } from "../src/bundle-pack.js";
import { loadBundle } from "../src/bundle.js";

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function unzipTo(zipPath: string): string {
  const dest = scratchDir("deckd-pack-unzipped-");
  execFileSync("unzip", ["-q", zipPath, "-d", dest]);
  return dest;
}

describe("packBundle", () => {
  it("packs an existing deckd.json repo's manifest-referenced paths, verbatim", async () => {
    const repo = scratchDir("deckd-pack-repo-");
    writeFileSync(join(repo, "theme.css"), "/* theme */");
    mkdirSync(join(repo, "assets"), { recursive: true });
    writeFileSync(join(repo, "assets", "logo.svg"), "<svg/>");
    mkdirSync(join(repo, "presentations", "example-deck"), { recursive: true });
    writeFileSync(join(repo, "presentations", "example-deck", "slides.md"), "# Example\n");
    writeFileSync(join(repo, "CLAUDE.md"), "# Guide\n");
    // Not referenced by the manifest -- must not appear in the zip.
    writeFileSync(join(repo, "README.md"), "# not part of the bundle\n");
    writeFileSync(
      join(repo, "deckd.json"),
      JSON.stringify({ theme: "theme.css", assets: "assets", examples: "presentations", guide: "CLAUDE.md" }),
    );

    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");
    const result = await packBundle({ cwd: repo, outPath });

    expect(existsSync(outPath)).toBe(true);
    expect(result.manifest).toEqual({ theme: "theme.css", assets: "assets", examples: "presentations", guide: "CLAUDE.md" });

    const extracted = unzipTo(outPath);
    expect(existsSync(join(extracted, "README.md"))).toBe(false);
    const bundle = loadBundle(extracted);
    expect(readFileSync(bundle.themeCss, "utf8")).toBe("/* theme */");
    expect(readFileSync(join(bundle.examplesDir ?? "", "example-deck", "slides.md"), "utf8")).toContain("# Example");
  });

  it("synthesizes a manifest from CLI flags for a repo with no deckd.json, writing it only into the zip", async () => {
    const repo = scratchDir("deckd-pack-noflags-repo-");
    mkdirSync(join(repo, "themes"), { recursive: true });
    writeFileSync(join(repo, "themes", "brand.css"), "/* flag theme */");
    mkdirSync(join(repo, "presentations", "deck-one"), { recursive: true });
    writeFileSync(join(repo, "presentations", "deck-one", "slides.md"), "# One\n");

    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");
    const result = await packBundle({ cwd: repo, outPath, theme: "themes/brand.css", examples: "presentations" });

    expect(result.manifest).toEqual({ theme: "themes/brand.css", assets: undefined, examples: "presentations", guide: undefined });
    expect(existsSync(join(repo, "deckd.json"))).toBe(false);

    const extracted = unzipTo(outPath);
    const bundle = loadBundle(extracted);
    expect(readFileSync(bundle.themeCss, "utf8")).toBe("/* flag theme */");
  });

  it("fails clearly when there is no deckd.json and no --theme flag", async () => {
    const repo = scratchDir("deckd-pack-notheme-repo-");
    writeFileSync(join(repo, "theme.css"), "/* theme */");
    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");

    await expect(packBundle({ cwd: repo, outPath })).rejects.toThrow(/--theme/);
  });

  it("rejects a synthesized theme path that resolves outside cwd", async () => {
    const repo = scratchDir("deckd-pack-escape-repo-");
    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");

    await expect(packBundle({ cwd: repo, outPath, theme: "../evil.css" })).rejects.toThrow(/must not contain/);
  });

  it("excludes a symlink and a .py file from a packed example deck", async () => {
    const repo = scratchDir("deckd-pack-clean-repo-");
    writeFileSync(join(repo, "theme.css"), "/* theme */");
    const deckDir = join(repo, "presentations", "with-chart");
    mkdirSync(deckDir, { recursive: true });
    writeFileSync(join(deckDir, "slides.md"), "# With chart\n");
    writeFileSync(join(deckDir, "charts.py"), "print('should not be packed')");
    const outsideDir = scratchDir("deckd-pack-outside-");
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    symlinkSync(join(outsideDir, "secret.txt"), join(deckDir, "linked.png"));
    writeFileSync(join(repo, "deckd.json"), JSON.stringify({ theme: "theme.css", examples: "presentations" }));

    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");
    await packBundle({ cwd: repo, outPath });

    const extracted = unzipTo(outPath);
    expect(existsSync(join(extracted, "presentations", "with-chart", "slides.md"))).toBe(true);
    expect(existsSync(join(extracted, "presentations", "with-chart", "charts.py"))).toBe(false);
    expect(existsSync(join(extracted, "presentations", "with-chart", "linked.png"))).toBe(false);
  });

  // Regression: a dev checkout's example deck commonly has its own previously
  // rendered .pdf/.pptx sitting next to slides.md (render.sh's own output, or
  // deckd's). Packing those in would produce a zip that PUT /api/bundle always
  // rejects, since .pdf/.pptx aren't on bundle-upload.ts's content allowlist.
  it("excludes a rendered .pdf and .pptx from a packed example deck", async () => {
    const repo = scratchDir("deckd-pack-rendered-output-repo-");
    writeFileSync(join(repo, "theme.css"), "/* theme */");
    const deckDir = join(repo, "presentations", "with-output");
    mkdirSync(deckDir, { recursive: true });
    writeFileSync(join(deckDir, "slides.md"), "# With output\n");
    writeFileSync(join(deckDir, "with-output.pdf"), "%PDF-1.4 fake");
    writeFileSync(join(deckDir, "with-output-editable.pptx"), "fake pptx bytes");
    writeFileSync(join(repo, "deckd.json"), JSON.stringify({ theme: "theme.css", examples: "presentations" }));

    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");
    await packBundle({ cwd: repo, outPath });

    const extracted = unzipTo(outPath);
    expect(existsSync(join(extracted, "presentations", "with-output", "slides.md"))).toBe(true);
    expect(existsSync(join(extracted, "presentations", "with-output", "with-output.pdf"))).toBe(false);
    expect(existsSync(join(extracted, "presentations", "with-output", "with-output-editable.pptx"))).toBe(false);
  });

  // A source checkout (e.g. the presentations repo) is not deckd-owned, so pack must
  // skip OS junk when staging the zip without ever deleting it from the caller's tree.
  it("excludes OS junk (.DS_Store, __MACOSX, Thumbs.db) from a packed bundle, without touching the source repo", async () => {
    const repo = scratchDir("deckd-pack-osjunk-repo-");
    writeFileSync(join(repo, "theme.css"), "/* theme */");
    mkdirSync(join(repo, "assets"), { recursive: true });
    writeFileSync(join(repo, "assets", "logo.svg"), "<svg/>");
    writeFileSync(join(repo, "assets", ".DS_Store"), "junk");
    const deckDir = join(repo, "presentations", "example-deck");
    mkdirSync(deckDir, { recursive: true });
    writeFileSync(join(deckDir, "slides.md"), "# Example\n");
    writeFileSync(join(deckDir, "Thumbs.db"), "junk");
    mkdirSync(join(repo, "__MACOSX"), { recursive: true });
    writeFileSync(join(repo, "__MACOSX", "._theme.css"), "junk");
    writeFileSync(join(repo, "deckd.json"), JSON.stringify({ theme: "theme.css", assets: "assets", examples: "presentations" }));

    const outPath = join(scratchDir("deckd-pack-out-"), "bundle.zip");
    await packBundle({ cwd: repo, outPath });

    const extracted = unzipTo(outPath);
    expect(existsSync(join(extracted, "assets", ".DS_Store"))).toBe(false);
    expect(existsSync(join(extracted, "presentations", "example-deck", "Thumbs.db"))).toBe(false);
    expect(existsSync(join(extracted, "assets", "logo.svg"))).toBe(true);
    // pack must never delete from the source repo, only skip junk when staging.
    expect(existsSync(join(repo, "assets", ".DS_Store"))).toBe(true);
  });
});

describe("zipBundleDir", () => {
  it("excludes OS junk sitting in the live bundle dir, deleting it there since deckd owns that directory", async () => {
    const bundleDir = scratchDir("deckd-zipbundledir-");
    writeFileSync(join(bundleDir, "theme.css"), "/* theme */");
    writeFileSync(join(bundleDir, "deckd.json"), JSON.stringify({ theme: "theme.css" }));
    writeFileSync(join(bundleDir, ".DS_Store"), "junk");
    mkdirSync(join(bundleDir, "assets"), { recursive: true });
    writeFileSync(join(bundleDir, "assets", "Thumbs.db"), "junk");

    const outPath = join(scratchDir("deckd-zipbundledir-out-"), "bundle.zip");
    await zipBundleDir(bundleDir, outPath);

    const extracted = unzipTo(outPath);
    expect(existsSync(join(extracted, "theme.css"))).toBe(true);
    expect(existsSync(join(extracted, ".DS_Store"))).toBe(false);
    expect(existsSync(join(extracted, "assets", "Thumbs.db"))).toBe(false);
    expect(existsSync(join(bundleDir, ".DS_Store"))).toBe(false);
  });
});
