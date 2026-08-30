import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpAppDir } from "./helpers.js";
import {
  slugify, listDecks, deckPaths, seedDeck, saveAsset, saveAssetAt, exportZip, syncCanonicalDeckCache, isExcludedDeckEntry,
  isOsJunkEntry, stripOsJunk, deriveThemeName,
} from "../src/artifacts.js";

describe("artifacts", () => {
  it("slugify", () => {
    expect(slugify("Board Deck: AI!")).toBe("board-deck-ai");
  });
  it("seeds a blank deck, lists decks", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "my-deck", { kind: "blank", title: "My deck" });
    expect(listDecks(appDir)).toEqual(["my-deck"]);
    expect(readFileSync(join(appDir, "presentations/my-deck/slides.md"), "utf8")).toContain("# My deck");
  });
  it("seeds a blank deck with no theme line when no themeName is given", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "no-theme", { kind: "blank", title: "No theme" });
    const md = readFileSync(join(appDir, "presentations/no-theme/slides.md"), "utf8");
    expect(md).not.toMatch(/^theme:/m);
  });
  it("seeds a blank deck with a theme line naming the given themeName", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "themed", { kind: "blank", title: "Themed", themeName: "sample" });
    const md = readFileSync(join(appDir, "presentations/themed/slides.md"), "utf8");
    expect(md).toContain("theme: sample");
  });
  describe("deriveThemeName", () => {
    it("parses the theme name from a bundle CSS's /* @theme <name> */ header", () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-theme-name-"));
      const themeCss = join(dir, "theme.css");
      writeFileSync(themeCss, "/* @theme sample */\nsection { background: white; }\n");
      expect(deriveThemeName(themeCss)).toBe("sample");
    });
    it("returns undefined when the CSS has no @theme header", () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-theme-name-"));
      const themeCss = join(dir, "theme.css");
      writeFileSync(themeCss, "section { background: white; }\n");
      expect(deriveThemeName(themeCss)).toBeUndefined();
    });
  });
  it("saveAsset validates and writes", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "d", { kind: "blank", title: "d" });
    const rel = saveAsset(appDir, "d", "logo.png", Buffer.from("x"));
    expect(rel).toBe("images/logo.png");
    expect(existsSync(join(appDir, "presentations/d/images/logo.png"))).toBe(true);
    expect(() => saveAsset(appDir, "d", "../evil.png", Buffer.from("x"))).toThrow();
    expect(() => saveAsset(appDir, "d", "x.exe", Buffer.from("x"))).toThrow();
  });
  describe("saveAssetAt", () => {
    it("saves into images/ or charts/ subdirectories the caller chooses", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      expect(saveAssetAt(appDir, "d", "images/logo.png", Buffer.from("x"), 1024)).toBe("images/logo.png");
      expect(saveAssetAt(appDir, "d", "charts/plot.svg", Buffer.from("<svg/>"), 1024)).toBe("charts/plot.svg");
      expect(existsSync(join(appDir, "presentations/d/images/logo.png"))).toBe(true);
      expect(existsSync(join(appDir, "presentations/d/charts/plot.svg"))).toBe(true);
    });
    it("rejects path traversal and absolute paths", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      expect(() => saveAssetAt(appDir, "d", "../evil.png", Buffer.from("x"), 1024)).toThrow();
      expect(() => saveAssetAt(appDir, "d", "images/../../evil.png", Buffer.from("x"), 1024)).toThrow();
      expect(() => saveAssetAt(appDir, "d", "/etc/evil.png", Buffer.from("x"), 1024)).toThrow();
      expect(existsSync(join(appDir, "presentations", "evil.png"))).toBe(false);
    });
    it("rejects an unsupported extension", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      expect(() => saveAssetAt(appDir, "d", "images/x.exe", Buffer.from("x"), 1024)).toThrow();
    });
    it("rejects data over the caller-supplied size cap", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      expect(() => saveAssetAt(appDir, "d", "images/big.png", Buffer.alloc(2048), 1024)).toThrow(/too large/);
    });
    it("refuses to write through a pre-existing symlink at the destination", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      const outsideDir = mkdtempSync(join(tmpdir(), "deckd-outside-"));
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");
      mkdirSync(join(appDir, "presentations/d/images"), { recursive: true });
      symlinkSync(join(outsideDir, "secret.txt"), join(appDir, "presentations/d/images/logo.png"));
      expect(() => saveAssetAt(appDir, "d", "images/logo.png", Buffer.from("x"), 1024)).toThrow();
      expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("top secret");
    });
    it("rejects a relPath whose first segment is preview, case-insensitively", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      expect(() => saveAssetAt(appDir, "d", "preview/logo.png", Buffer.from("x"), 1024)).toThrow();
      expect(() => saveAssetAt(appDir, "d", "Preview/logo.png", Buffer.from("x"), 1024)).toThrow();
      expect(existsSync(join(appDir, "presentations/d/preview"))).toBe(false);
    });
    it("rejects a dangling symlink segment in the path with the symlink error, not a raw ENOENT", async () => {
      const appDir = tmpAppDir();
      await seedDeck(appDir, "d", { kind: "blank", title: "d" });
      symlinkSync(join(appDir, "presentations/d/nonexistent-target"), join(appDir, "presentations/d/images"));
      expect(() => saveAssetAt(appDir, "d", "images/logo.png", Buffer.from("x"), 1024)).toThrow(/symlink in path/);
    });
  });

  it("exportZip contains the deck files; zip seed round-trips", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "d", { kind: "blank", title: "d" });
    writeFileSync(join(appDir, "presentations/d/d.pdf"), "pdf");
    const outDir = mkdtempSync(join(tmpdir(), "deckd-zipout-"));
    const out = join(outDir, "out.zip");
    await exportZip(appDir, "d", out);
    const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
    expect(listing).toContain("slides.md");
    expect(listing).toContain("d.pdf");
    const appDir2 = tmpAppDir();
    await seedDeck(appDir2, "restored", { kind: "zip", zipPath: out });
    expect(readFileSync(join(appDir2, "presentations/restored/slides.md"), "utf8")).toContain("# d");
  });
  // preview/ holds host-rendered slide PNGs for an AI to look at (see
  // host-render.ts's renderPreviews) — derived output, not deck content, so a
  // user-facing export must never ship it.
  it("exportZip excludes the preview/ directory", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "d", { kind: "blank", title: "d" });
    mkdirSync(join(appDir, "presentations/d/preview"), { recursive: true });
    writeFileSync(join(appDir, "presentations/d/preview/d.001.png"), "png");
    const outDir = mkdtempSync(join(tmpdir(), "deckd-zipout-"));
    const out = join(outDir, "out.zip");
    await exportZip(appDir, "d", out);
    const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
    expect(listing).toContain("slides.md");
    expect(listing).not.toContain("preview");
  });
  it("strips OS junk (__MACOSX, .DS_Store) from an imported zip so the single-top-level-folder heuristic still applies", async () => {
    // A Finder zip of a "my-deck" folder produces a __MACOSX/ sibling at the top
    // level alongside my-deck/ -- without stripping, entries.length would be 2, not
    // 1, and the "flatten a single wrapper dir" heuristic below would never fire.
    const scratch = mkdtempSync(join(tmpdir(), "deckd-osjunk-import-"));
    mkdirSync(join(scratch, "my-deck"), { recursive: true });
    writeFileSync(join(scratch, "my-deck", "slides.md"), "# nested-marker");
    writeFileSync(join(scratch, "my-deck", ".DS_Store"), "junk");
    mkdirSync(join(scratch, "__MACOSX", "my-deck"), { recursive: true });
    writeFileSync(join(scratch, "__MACOSX", "my-deck", "._slides.md"), "junk");
    const out = join(scratch, "out.zip");
    execFileSync("zip", ["-r", out, "."], { cwd: scratch });

    const appDir = tmpAppDir();
    await seedDeck(appDir, "junk-import", { kind: "zip", zipPath: out });

    const deckDir = join(appDir, "presentations", "junk-import");
    expect(readFileSync(join(deckDir, "slides.md"), "utf8")).toContain("nested-marker");
    expect(existsSync(join(deckDir, "__MACOSX"))).toBe(false);
    expect(existsSync(join(deckDir, ".DS_Store"))).toBe(false);
  });

  it("exportZip excludes OS junk sitting in the deck dir, deleting it in place", async () => {
    const appDir = tmpAppDir();
    await seedDeck(appDir, "d", { kind: "blank", title: "d" });
    writeFileSync(join(appDir, "presentations/d/.DS_Store"), "junk");
    const outDir = mkdtempSync(join(tmpdir(), "deckd-zipout-"));
    const out = join(outDir, "out.zip");
    await exportZip(appDir, "d", out);
    const listing = execFileSync("unzip", ["-l", out], { encoding: "utf8" });
    expect(listing).toContain("slides.md");
    expect(listing).not.toContain(".DS_Store");
    expect(existsSync(join(appDir, "presentations/d/.DS_Store"))).toBe(false);
  });

  it("zip seed flattens a single wrapper dir", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-wrapper-"));
    mkdirSync(join(scratch, "wrapper"));
    writeFileSync(join(scratch, "wrapper", "slides.md"), "# wrapped-marker");
    const out = join(scratch, "out.zip");
    execFileSync("zip", ["-r", out, "wrapper"], { cwd: scratch });
    const appDir = tmpAppDir();
    await seedDeck(appDir, "flat", { kind: "zip", zipPath: out });
    expect(readFileSync(join(appDir, "presentations/flat/slides.md"), "utf8")).toContain("wrapped-marker");
  });
  it("rejects a zip with a path-traversal entry and writes nothing outside the tmp extraction area", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipslip-"));
    const zipPath = join(scratch, "evil.zip");
    execFileSync("python3", [
      "-c",
      `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}, "w").writestr("../evil.txt", "x")`,
    ]);
    const appDir = tmpAppDir();
    await expect(seedDeck(appDir, "evil", { kind: "zip", zipPath })).rejects.toThrow(/unsafe zip entry/);
    expect(existsSync(join(appDir, "presentations", "evil", "slides.md"))).toBe(false);
    expect(existsSync(join(appDir, "presentations", "evil.unzip"))).toBe(false);
    expect(existsSync(join(appDir, "..", "evil.txt"))).toBe(false);
    expect(existsSync(join(appDir, "..", "..", "..", "evil.txt"))).toBe(false);
  });
  it("rejects a zip with an absolute-path entry", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipabs-"));
    const zipPath = join(scratch, "evil.zip");
    execFileSync("python3", [
      "-c",
      `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}, "w").writestr("/etc/passwd", "x")`,
    ]);
    const appDir = tmpAppDir();
    await expect(seedDeck(appDir, "evil", { kind: "zip", zipPath })).rejects.toThrow(/unsafe zip entry/);
    expect(existsSync(join(appDir, "presentations", "evil", "slides.md"))).toBe(false);
    expect(existsSync(join(appDir, "presentations", "evil.unzip"))).toBe(false);
  });
  it("rejects a zip with a backslash entry", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipbackslash-"));
    const zipPath = join(scratch, "evil.zip");
    execFileSync("python3", [
      "-c",
      `import zipfile; zipfile.ZipFile(${JSON.stringify(zipPath)}, "w").writestr("sub\\\\evil.txt", "x")`,
    ]);
    const appDir = tmpAppDir();
    await expect(seedDeck(appDir, "evil", { kind: "zip", zipPath })).rejects.toThrow(/unsafe zip entry/);
    expect(existsSync(join(appDir, "presentations", "evil", "slides.md"))).toBe(false);
    expect(existsSync(join(appDir, "presentations", "evil.unzip"))).toBe(false);
  });
  it("rejects a deck-import zip whose decoded content overflows the size caps mid-extraction", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipbomb-"));
    const zipPath = join(scratch, "bomb.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w", zipfile.ZIP_DEFLATED)
zf.writestr("slides.md", "# ok")
zf.writestr("images/huge.bin", b"\\0" * (200 * 1024 * 1024))
zf.close()
`,
    ]);
    const appDir = tmpAppDir();
    await expect(seedDeck(appDir, "bomb", { kind: "zip", zipPath })).rejects.toThrow(/exceeds the per-file cap/);
    expect(existsSync(join(appDir, "presentations", "bomb", "slides.md"))).toBe(false);
    expect(existsSync(join(appDir, "presentations", "bomb.unzip"))).toBe(false);
  });
  it("extracts a symlink entry from a DOS/Windows-style zip as a regular file, not a misfired symlink", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipdossym-"));
    const zipPath = join(scratch, "dos.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
zf.writestr("slides.md", "# ok")
info = zipfile.ZipInfo("looks-like-a-link")
info.create_system = 0
# No unix permission bits at all (a real DOS/Windows zip never sets them), so
# isSymlinkEntry's S_IFLNK check has nothing to read -- this must fall through
# to a normal file write, not be skipped or misread as a symlink.
zf.writestr(info, "just some text, not a link target")
zf.close()
`,
    ]);
    const appDir = tmpAppDir();
    await seedDeck(appDir, "dos", { kind: "zip", zipPath });
    const deckDir = join(appDir, "presentations", "dos");
    const p = join(deckDir, "looks-like-a-link");
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("just some text, not a link target");
  });
  it("strips a symlink entry from an imported zip instead of letting it land in deckDir", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipsymlink-"));
    const zipPath = join(scratch, "evil-link.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile, stat
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
zf.writestr("slides.md", "# ok")
info = zipfile.ZipInfo("secret")
info.create_system = 3
info.external_attr = (stat.S_IFLNK | 0o777) << 16
zf.writestr(info, "/etc/passwd")
zf.close()
`,
    ]);
    const appDir = tmpAppDir();
    await seedDeck(appDir, "linked", { kind: "zip", zipPath });
    const deckDir = join(appDir, "presentations", "linked");
    expect(readFileSync(join(deckDir, "slides.md"), "utf8")).toContain("# ok");
    expect(existsSync(join(deckDir, "secret"))).toBe(false);
    expect(() => lstatSync(join(deckDir, "secret"))).toThrow();
  });
  it("strips a symlink nested inside a subdirectory of an imported zip", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "deckd-zipsymlink-nested-"));
    const zipPath = join(scratch, "evil-nested-link.zip");
    execFileSync("python3", [
      "-c",
      `
import zipfile, stat
zf = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
zf.writestr("slides.md", "# ok")
info = zipfile.ZipInfo("sub/secret")
info.create_system = 3
info.external_attr = (stat.S_IFLNK | 0o777) << 16
zf.writestr(info, "/etc/passwd")
zf.close()
`,
    ]);
    const appDir = tmpAppDir();
    await seedDeck(appDir, "nested-linked", { kind: "zip", zipPath });
    const deckDir = join(appDir, "presentations", "nested-linked");
    expect(readFileSync(join(deckDir, "slides.md"), "utf8")).toContain("# ok");
    expect(existsSync(join(deckDir, "sub", "secret"))).toBe(false);
    expect(() => lstatSync(join(deckDir, "sub", "secret"))).toThrow();
  });

  describe("isExcludedDeckEntry", () => {
    it("excludes charts.py, __pycache__, any .py file, and preview, case-insensitively", () => {
      expect(isExcludedDeckEntry("charts.py")).toBe(true);
      expect(isExcludedDeckEntry("Charts.py")).toBe(true);
      expect(isExcludedDeckEntry("__pycache__")).toBe(true);
      expect(isExcludedDeckEntry("notes.py")).toBe(true);
      expect(isExcludedDeckEntry("preview")).toBe(true);
      expect(isExcludedDeckEntry("PREVIEW")).toBe(true);
      expect(isExcludedDeckEntry("slides.md")).toBe(false);
      expect(isExcludedDeckEntry("images")).toBe(false);
    });

    it("excludes rendered .pdf and .pptx output, case-insensitively", () => {
      expect(isExcludedDeckEntry("my-deck.pdf")).toBe(true);
      expect(isExcludedDeckEntry("my-deck.PDF")).toBe(true);
      expect(isExcludedDeckEntry("my-deck-editable.pptx")).toBe(true);
      expect(isExcludedDeckEntry("my-deck-editable.PPTX")).toBe(true);
    });
  });

  describe("isOsJunkEntry", () => {
    it("matches macOS/Windows zip-tool noise, case-insensitively", () => {
      expect(isOsJunkEntry("__MACOSX")).toBe(true);
      expect(isOsJunkEntry("__macosx")).toBe(true);
      expect(isOsJunkEntry("._deckd-bundle")).toBe(true);
      expect(isOsJunkEntry("._Resource")).toBe(true);
      expect(isOsJunkEntry(".DS_Store")).toBe(true);
      expect(isOsJunkEntry(".ds_store")).toBe(true);
      expect(isOsJunkEntry("Thumbs.db")).toBe(true);
      expect(isOsJunkEntry("thumbs.db")).toBe(true);
      expect(isOsJunkEntry("desktop.ini")).toBe(true);
      expect(isOsJunkEntry("DESKTOP.INI")).toBe(true);
      expect(isOsJunkEntry("ehthumbs.db")).toBe(true);
    });

    it("does not match an ordinary dotfile or real content", () => {
      expect(isOsJunkEntry(".gitignore")).toBe(false);
      expect(isOsJunkEntry(".env")).toBe(false);
      expect(isOsJunkEntry("theme.css")).toBe(false);
      expect(isOsJunkEntry("slides.md")).toBe(false);
    });
  });

  describe("stripOsJunk", () => {
    it("recursively deletes OS-junk entries, leaving real content untouched", () => {
      const dir = mkdtempSync(join(tmpdir(), "deckd-osjunk-strip-"));
      mkdirSync(join(dir, "__MACOSX"), { recursive: true });
      writeFileSync(join(dir, "__MACOSX", "._deckd-bundle"), "junk");
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "assets", ".DS_Store"), "junk");
      writeFileSync(join(dir, "assets", "logo.svg"), "<svg/>");
      writeFileSync(join(dir, "Thumbs.db"), "junk");
      writeFileSync(join(dir, "theme.css"), "/* theme */");

      stripOsJunk(dir);

      expect(existsSync(join(dir, "__MACOSX"))).toBe(false);
      expect(existsSync(join(dir, "assets", ".DS_Store"))).toBe(false);
      expect(existsSync(join(dir, "Thumbs.db"))).toBe(false);
      expect(existsSync(join(dir, "assets", "logo.svg"))).toBe(true);
      expect(existsSync(join(dir, "theme.css"))).toBe(true);
    });
  });

  describe("syncCanonicalDeckCache", () => {
    it("copies every deck entry except *.py files and symlinks, and never touches the examples dir", () => {
      const examplesDir = mkdtempSync(join(tmpdir(), "deckd-examples-"));
      const canonDir = join(examplesDir, "canon-deck");
      mkdirSync(join(canonDir, "images"), { recursive: true });
      mkdirSync(join(canonDir, "charts"), { recursive: true });
      writeFileSync(join(canonDir, "slides.md"), "# canon");
      writeFileSync(join(canonDir, "charts.py"), "print('should not be cached')");
      writeFileSync(join(canonDir, "foo.py"), "print('also not cached')");
      writeFileSync(join(canonDir, "outline.md"), "deck notes");
      writeFileSync(join(canonDir, "images", "logo.png"), "png-bytes");
      writeFileSync(join(canonDir, "charts", "plot.svg"), "<svg>chart</svg>");
      const outsideDir = mkdtempSync(join(tmpdir(), "deckd-outside-"));
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");
      symlinkSync(join(outsideDir, "secret.txt"), join(canonDir, "images", "linked.png"));

      const cacheRoot = mkdtempSync(join(tmpdir(), "deckd-cache-"));
      const before = readdirSync(canonDir).sort();

      const cacheDeckDir = syncCanonicalDeckCache(examplesDir, cacheRoot, "canon-deck");

      expect(readFileSync(join(cacheDeckDir, "slides.md"), "utf8")).toBe("# canon");
      expect(readFileSync(join(cacheDeckDir, "outline.md"), "utf8")).toBe("deck notes");
      expect(readFileSync(join(cacheDeckDir, "images", "logo.png"), "utf8")).toBe("png-bytes");
      // charts/ (or any other non-.py asset dir a deck keeps) is cached too, not just images/
      expect(readFileSync(join(cacheDeckDir, "charts", "plot.svg"), "utf8")).toBe("<svg>chart</svg>");
      expect(existsSync(join(cacheDeckDir, "charts.py"))).toBe(false);
      expect(existsSync(join(cacheDeckDir, "foo.py"))).toBe(false);
      expect(existsSync(join(cacheDeckDir, "images", "linked.png"))).toBe(false);

      // the examples dir itself must be completely untouched
      expect(readdirSync(canonDir).sort()).toEqual(before);
      expect(readFileSync(join(canonDir, "charts.py"), "utf8")).toBe("print('should not be cached')");
    });

    // Must match syncDeckMirror's exclusion rules (host-render.ts), not just its own
    // subset — preview/ is renderPreviews' own generated output, not deck content.
    it("skips a preview/ directory, matching syncDeckMirror's exclusion rules", () => {
      const examplesDir = mkdtempSync(join(tmpdir(), "deckd-examples-"));
      const canonDir = join(examplesDir, "canon-deck");
      mkdirSync(join(canonDir, "preview"), { recursive: true });
      writeFileSync(join(canonDir, "slides.md"), "# canon");
      writeFileSync(join(canonDir, "preview", "canon-deck.001.png"), "png");
      const cacheRoot = mkdtempSync(join(tmpdir(), "deckd-cache-"));

      const cacheDeckDir = syncCanonicalDeckCache(examplesDir, cacheRoot, "canon-deck");

      expect(readFileSync(join(cacheDeckDir, "slides.md"), "utf8")).toBe("# canon");
      expect(existsSync(join(cacheDeckDir, "preview"))).toBe(false);
    });

    it("re-syncs on the next call, dropping files removed upstream", () => {
      const examplesDir = mkdtempSync(join(tmpdir(), "deckd-examples-"));
      const canonDir = join(examplesDir, "canon-deck");
      mkdirSync(join(canonDir, "images"), { recursive: true });
      writeFileSync(join(canonDir, "slides.md"), "# v1");
      writeFileSync(join(canonDir, "images", "old.png"), "old");
      const cacheRoot = mkdtempSync(join(tmpdir(), "deckd-cache-"));

      const cacheDeckDir1 = syncCanonicalDeckCache(examplesDir, cacheRoot, "canon-deck");
      expect(existsSync(join(cacheDeckDir1, "images", "old.png"))).toBe(true);

      execFileSync("rm", [join(canonDir, "images", "old.png")]);
      writeFileSync(join(canonDir, "slides.md"), "# v2");

      const cacheDeckDir2 = syncCanonicalDeckCache(examplesDir, cacheRoot, "canon-deck");
      expect(readFileSync(join(cacheDeckDir2, "slides.md"), "utf8")).toBe("# v2");
      expect(existsSync(join(cacheDeckDir2, "images", "old.png"))).toBe(false);
    });
  });
});
