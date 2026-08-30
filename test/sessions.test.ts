import { describe, it, expect } from "vitest";
import { SessionService } from "../src/sessions.js";
import { SessionStore } from "../src/store.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { createBundleRef, type BundleRef } from "../src/bundle.js";
import { makeBundle } from "./helpers.js";

function cfgFor(localSessionsRoot: string): Config {
  return {
    port: 0, dbPath: ":memory:", devUser: "a@example.com",
    bundleDir: "/tmp/deckd-test-bundle-unused", scratchDir: "/tmp/deckd-test-scratch-unused",
    canonicalCacheDir: "/tmp/deckd-test-cache-unused",
    localSessionsRoot,
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
}

// makeBundle's theme.css carries `/* @theme sample */` (see test/helpers.ts), so a
// blank deck seeded against this bundleRef always derives "sample" as its theme name.
function bundleRefFor(): BundleRef {
  return createBundleRef(makeBundle());
}

describe("SessionService.create", () => {
  it("seeds the dir tree directly and stores a local row", async () => {
    const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localSessionsRoot);
    const svc = new SessionService(new SessionStore(":memory:"), cfg, bundleRefFor());

    const row = await svc.create("a@example.com", "My Local Deck", { kind: "blank", title: "My Local Deck" });

    expect(row.kind).toBe("local");
    expect(row.slug).toBe("my-local-deck");
    expect(existsSync(join(localSessionsRoot, row.id, "presentations", "my-local-deck", "slides.md"))).toBe(true);
  });

  it("derives the blank deck's theme front-matter from the live bundle's CSS", async () => {
    const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localSessionsRoot);
    const svc = new SessionService(new SessionStore(":memory:"), cfg, bundleRefFor());

    const row = await svc.create("a@example.com", "Themed Deck", { kind: "blank", title: "Themed Deck" });

    const md = readFileSync(join(localSessionsRoot, row.id, "presentations", row.slug, "slides.md"), "utf8");
    expect(md).toContain("theme: sample");
  });

  it("rolls back the session directory when seeding fails", async () => {
    const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localSessionsRoot);
    const svc = new SessionService(new SessionStore(":memory:"), cfg, bundleRefFor());

    await expect(
      svc.create("a@example.com", "Bad Zip", { kind: "zip", zipPath: "/no/such/file.zip" }),
    ).rejects.toThrow();

    // the root itself is untouched; the failed session's own subdirectory was rolled back
    expect(existsSync(localSessionsRoot)).toBe(true);
    expect(readdirSync(localSessionsRoot)).toEqual([]);
  });
});

describe("SessionService.remove", () => {
  it("removes the row and the directory", async () => {
    const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const cfg = cfgFor(localSessionsRoot);
    const store = new SessionStore(":memory:");
    const svc = new SessionService(store, cfg, bundleRefFor());
    const row = await svc.create("a@example.com", "To Delete", { kind: "blank", title: "To Delete" });
    const dir = join(localSessionsRoot, row.id);
    expect(existsSync(dir)).toBe(true);

    await svc.remove(row.id);

    expect(existsSync(dir)).toBe(false);
    expect(store.get(row.id)).toBeNull();
  });

  it("is a no-op for an unknown id", async () => {
    const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-local-root-"));
    const svc = new SessionService(new SessionStore(":memory:"), cfgFor(localSessionsRoot), bundleRefFor());
    await expect(svc.remove("no-such-id")).resolves.toBeUndefined();
  });
});
