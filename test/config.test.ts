import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("loadConfig", () => {
  it("defaults every data dir under DECKD_DATA_DIR (or cwd/data)", () => {
    const cfg = loadConfig({ DECKD_DATA_DIR: "/tmp/deckd-test-data", DECKD_CHROME_PATH: "/tmp/fake-chrome" });
    expect(cfg.port).toBe(8790);
    expect(cfg.devUser).toBe("dev@localhost");
    expect(cfg.dbPath).toBe("/tmp/deckd-test-data/deckd.sqlite3");
    expect(cfg.bundleDir).toBe("/tmp/deckd-test-data/bundle");
    expect(cfg.scratchDir).toBe("/tmp/deckd-test-data/render-scratch");
    expect(cfg.canonicalCacheDir).toBe("/tmp/deckd-test-data/canonical-cache");
    expect(cfg.localSessionsRoot).toBe("/tmp/deckd-test-data/local-sessions");
    expect(cfg.chromePath).toBe("/tmp/fake-chrome");
  });
  it("falls back to cwd/data when DECKD_DATA_DIR is unset", () => {
    const cfg = loadConfig({ DECKD_CHROME_PATH: "/tmp/fake-chrome" });
    expect(cfg.bundleDir).toBe(join(process.cwd(), "data", "bundle"));
    expect(cfg.dbPath).toBe(join(process.cwd(), "data", "deckd.sqlite3"));
  });
  it("honors DECKD_DB, DECKD_BUNDLE_DIR, DECKD_SCRATCH_DIR, DECKD_CANONICAL_CACHE_DIR and DECKD_LOCAL_SESSIONS_DIR overrides", () => {
    const cfg = loadConfig({
      DECKD_DATA_DIR: "/tmp/deckd-test-data",
      DECKD_DB: "/tmp/other-deckd.sqlite3",
      DECKD_BUNDLE_DIR: "/tmp/other-bundle",
      DECKD_SCRATCH_DIR: "/tmp/other-scratch",
      DECKD_CANONICAL_CACHE_DIR: "/tmp/other-cache",
      DECKD_LOCAL_SESSIONS_DIR: "/tmp/other-local",
      DECKD_CHROME_PATH: "/tmp/fake-chrome",
    });
    expect(cfg.dbPath).toBe("/tmp/other-deckd.sqlite3");
    expect(cfg.bundleDir).toBe("/tmp/other-bundle");
    expect(cfg.scratchDir).toBe("/tmp/other-scratch");
    expect(cfg.canonicalCacheDir).toBe("/tmp/other-cache");
    expect(cfg.localSessionsRoot).toBe("/tmp/other-local");
  });

  describe("chromePath resolution", () => {
    const base = { DECKD_DATA_DIR: "/tmp/deckd-chrome-cfg-data" };
    const macDefault = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

    it("prefers DECKD_CHROME_PATH over CHROME_PATH", () => {
      const cfg = loadConfig({ ...base, DECKD_CHROME_PATH: "/opt/deckd-chrome", CHROME_PATH: "/opt/other-chrome" });
      expect(cfg.chromePath).toBe("/opt/deckd-chrome");
    });

    it("falls back to CHROME_PATH when DECKD_CHROME_PATH is unset", () => {
      const cfg = loadConfig({ ...base, CHROME_PATH: "/opt/other-chrome" });
      expect(cfg.chromePath).toBe("/opt/other-chrome");
    });

    it("falls back to the macOS default install path, or throws clearly if it's absent, when neither env var is set", () => {
      // This branch's outcome genuinely depends on whether the running machine has
      // Chrome installed at the default path -- there is no injection seam for
      // existsSync in config.ts (only `env` is a sanctioned injection point per this
      // repo's "env via config" convention), so both real outcomes are asserted as
      // correct rather than assuming one.
      if (existsSync(macDefault)) {
        expect(loadConfig({ ...base }).chromePath).toBe(macDefault);
      } else {
        expect(() => loadConfig({ ...base })).toThrow(/no Chrome binary found/);
      }
    });
  });
});
