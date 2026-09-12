import { describe, it, expect } from "vitest";
import { DeckService, migrateLegacyDecksRoot } from "../src/decks.js";
import { DeckStore } from "../src/store.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { createBundleRef, type BundleRef } from "../src/bundle.js";
import { makeBundle } from "./helpers.js";

function cfgFor(localDecksRoot: string): Config {
  return {
    port: 0, dbPath: ":memory:", devUser: "a@example.com",
    bundleDir: "/tmp/deckd-test-bundle-unused", scratchDir: "/tmp/deckd-test-scratch-unused",
    canonicalCacheDir: "/tmp/deckd-test-cache-unused",
    localDecksRoot,
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
}

// makeBundle's theme.css carries `/* @theme sample */` (see test/helpers.ts), so a
// blank deck seeded against this bundleRef always derives "sample" as its theme name.
function bundleRefFor(): BundleRef {
  return createBundleRef(makeBundle());
}

describe("DeckService.create", () => {
  it("seeds the dir tree directly and stores a local row", async () => {
    const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localDecksRoot);
    const svc = new DeckService(new DeckStore(":memory:"), cfg, bundleRefFor());

    const row = await svc.create("a@example.com", "My Local Deck", { kind: "blank", title: "My Local Deck" });

    expect(row.kind).toBe("local");
    expect(row.slug).toBe("my-local-deck");
    expect(existsSync(join(localDecksRoot, row.id, "presentations", "my-local-deck", "slides.md"))).toBe(true);
  });

  it("derives the blank deck's theme front-matter from the live bundle's CSS", async () => {
    const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localDecksRoot);
    const svc = new DeckService(new DeckStore(":memory:"), cfg, bundleRefFor());

    const row = await svc.create("a@example.com", "Themed Deck", { kind: "blank", title: "Themed Deck" });

    const md = readFileSync(join(localDecksRoot, row.id, "presentations", row.slug, "slides.md"), "utf8");
    expect(md).toContain("theme: sample");
  });

  it("rolls back the deck directory when seeding fails", async () => {
    const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localDecksRoot);
    const svc = new DeckService(new DeckStore(":memory:"), cfg, bundleRefFor());

    await expect(
      svc.create("a@example.com", "Bad Zip", { kind: "zip", zipPath: "/no/such/file.zip" }),
    ).rejects.toThrow();

    // the root itself is untouched; the failed deck's own subdirectory was rolled back
    expect(existsSync(localDecksRoot)).toBe(true);
    expect(readdirSync(localDecksRoot)).toEqual([]);
  });
});

describe("DeckService.remove", () => {
  it("removes the row and the directory", async () => {
    const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localDecksRoot);
    const store = new DeckStore(":memory:");
    const svc = new DeckService(store, cfg, bundleRefFor());
    const row = await svc.create("a@example.com", "To Delete", { kind: "blank", title: "To Delete" });
    const dir = join(localDecksRoot, row.id);
    expect(existsSync(dir)).toBe(true);

    await svc.remove(row.id);

    expect(existsSync(dir)).toBe(false);
    expect(store.get(row.id)).toBeNull();
  });

  it("is a no-op for an unknown id", async () => {
    const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const svc = new DeckService(new DeckStore(":memory:"), cfgFor(localDecksRoot), bundleRefFor());
    await expect(svc.remove("no-such-id")).resolves.toBeUndefined();
  });
});

describe("migrateLegacyDecksRoot", () => {
  it("renames a pre-rename local-sessions dir into place when local-decks does not exist yet", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "deckd-legacy-root-"));
    mkdirSync(join(dataDir, "local-sessions", "abc", "presentations", "d"), { recursive: true });
    const root = join(dataDir, "local-decks");
    migrateLegacyDecksRoot(root);
    expect(existsSync(join(root, "abc", "presentations", "d"))).toBe(true);
    expect(existsSync(join(dataDir, "local-sessions"))).toBe(false);
  });
  it("leaves both alone when local-decks already exists", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "deckd-legacy-root-"));
    mkdirSync(join(dataDir, "local-sessions", "old"), { recursive: true });
    mkdirSync(join(dataDir, "local-decks", "new"), { recursive: true });
    migrateLegacyDecksRoot(join(dataDir, "local-decks"));
    expect(existsSync(join(dataDir, "local-sessions", "old"))).toBe(true);
    expect(existsSync(join(dataDir, "local-decks", "new"))).toBe(true);
  });
  it("does nothing for a custom root name or a fresh install", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "deckd-legacy-root-"));
    mkdirSync(join(dataDir, "local-sessions"), { recursive: true });
    migrateLegacyDecksRoot(join(dataDir, "elsewhere"));
    expect(existsSync(join(dataDir, "elsewhere"))).toBe(false);
    migrateLegacyDecksRoot(join(mkdtempSync(join(tmpdir(), "deckd-fresh-")), "local-decks"));
  });
});
