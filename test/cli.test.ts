import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveMarpBinPath } from "../src/host-render.js";

// The package `bin` entry (see package.json and bin/deckd.mjs), not
// `node --import tsx src/cli.ts`: --import resolves the bare "tsx" specifier
// relative to the child process's own cwd, which is the fixture repo dir below
// (deliberately outside this repo and with no node_modules of its own) -- exactly
// the gap bin/deckd.mjs's tsImport-from-its-own-location approach exists to close
// (see that file's comment), and exercising it here doubles as a test that the
// documented `deckd` invocation actually works from a plain checkout.
const BIN_PATH = resolve(import.meta.dirname, "..", "bin", "deckd.mjs");

// Exec'ing the real CLI as a subprocess means the host-render exec seam can't be
// stubbed the way host-render.test.ts and server-bundle.test.ts do -- there's no
// way to inject a fake marpBinPath into a fresh `node` process's argv. So render/
// check/previews are exercised here for their real argument-validation and error
// paths (no deckd.json, no slides.md, a bad slug), and exactly one full render runs
// for real, gated on the pinned marp-cli actually being installed (see host-
// render.test.ts's identical E2E_AVAILABLE convention).
function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BIN_PATH, ...args], { cwd, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status: number | null; stdout: string; stderr: string };
    return { status: err.status ?? -1, stdout: err.stdout, stderr: err.stderr };
  }
}

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFixtureRepo(): string {
  const dir = scratchDir("deckd-cli-fixture-");
  writeFileSync(join(dir, "theme.css"), "/* @theme sample */\nsection { background: white; }\n");
  mkdirSync(join(dir, "presentations", "demo-deck"), { recursive: true });
  writeFileSync(
    join(dir, "presentations", "demo-deck", "slides.md"),
    "---\nmarp: true\ntheme: sample\n---\n\n# Hello\n",
  );
  writeFileSync(join(dir, "deckd.json"), JSON.stringify({ theme: "theme.css", examples: "presentations" }));
  return dir;
}

describe("deckd CLI", () => {
  it("prints usage and exits 1 with no command", () => {
    const r = runCli([], scratchDir("deckd-cli-noargs-"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: deckd");
  });

  it("--help prints usage and exits 0", () => {
    const r = runCli(["--help"], scratchDir("deckd-cli-help-"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: deckd");
  });

  it("an unknown command exits 1 with a clear message", () => {
    const r = runCli(["frobnicate"], scratchDir("deckd-cli-unknown-"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown command: frobnicate");
  });

  describe("render/check/previews argument validation", () => {
    it("render requires a deck directory", () => {
      const r = runCli(["render"], makeFixtureRepo());
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("a deck directory is required");
    });

    it("fails clearly when the current directory has no deckd.json", () => {
      const r = runCli(["render", "presentations/demo-deck"], scratchDir("deckd-cli-nobundle-"));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no deckd.json found");
    });

    it("fails clearly when the deck directory has no slides.md", () => {
      const repo = makeFixtureRepo();
      mkdirSync(join(repo, "presentations", "empty-deck"), { recursive: true });
      const r = runCli(["render", "presentations/empty-deck"], repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no slides.md found");
    });

    it("rejects a deck directory name that isn't a valid slug", () => {
      const repo = makeFixtureRepo();
      mkdirSync(join(repo, "presentations", "Not_A_Slug"), { recursive: true });
      writeFileSync(join(repo, "presentations", "Not_A_Slug", "slides.md"), "# x\n");
      const r = runCli(["render", "presentations/Not_A_Slug"], repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not a valid slug");
    });

    it("check and previews apply the same deck-dir/bundle validation as render", () => {
      const noBundle = scratchDir("deckd-cli-nobundle-2-");
      expect(runCli(["check", "presentations/demo-deck"], noBundle).stderr).toContain("no deckd.json found");
      expect(runCli(["previews", "presentations/demo-deck"], noBundle).stderr).toContain("no deckd.json found");
      expect(runCli(["check"], makeFixtureRepo()).stderr).toContain("a deck directory is required");
      expect(runCli(["previews"], makeFixtureRepo()).stderr).toContain("a deck directory is required");
    });
  });

  describe("pack", () => {
    it("packs a real deckd.json repo into a zip for real", () => {
      const repo = makeFixtureRepo();
      const r = runCli(["pack", "-o", "out.zip"], repo);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("out.zip");
      expect(existsSync(join(repo, "out.zip"))).toBe(true);
      const listing = execFileSync("unzip", ["-l", join(repo, "out.zip")], { encoding: "utf8" });
      expect(listing).toContain("deckd.json");
      expect(listing).toContain("theme.css");
      expect(listing).toContain("slides.md");
    });

    it("synthesizes a manifest from flags for a repo with no deckd.json, without writing one into the repo", () => {
      const repo = scratchDir("deckd-cli-pack-noflag-");
      mkdirSync(join(repo, "presentations", "solo-deck"), { recursive: true });
      writeFileSync(join(repo, "presentations", "solo-deck", "slides.md"), "# Solo\n");
      writeFileSync(join(repo, "my-theme.css"), "/* flag theme */\n");

      const r = runCli(["pack", "--theme", "my-theme.css", "--examples", "presentations", "-o", "flagged.zip"], repo);
      expect(r.status).toBe(0);
      expect(existsSync(join(repo, "deckd.json"))).toBe(false);
      const listing = execFileSync("unzip", ["-l", join(repo, "flagged.zip")], { encoding: "utf8" });
      expect(listing).toContain("my-theme.css");
      expect(listing).toContain("deckd.json");
    });

    it("fails clearly with no deckd.json and no --theme flag", () => {
      const repo = scratchDir("deckd-cli-pack-fail-");
      writeFileSync(join(repo, "theme.css"), "/* x */");
      const r = runCli(["pack"], repo);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--theme");
    });

    it("never touches Chrome (no chromePath resolution attempted)", () => {
      // A pack invocation with every Chrome env hint unset and no other flag
      // requesting Chrome must still succeed -- proof pack's code path never calls
      // resolveChromePath (see cli.ts's cmdPack).
      const repo = makeFixtureRepo();
      const r = runCli(["pack", "-o", "out.zip"], repo);
      expect(r.status).toBe(0);
    });
  });

  const E2E_AVAILABLE = (() => {
    try {
      resolveMarpBinPath();
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!E2E_AVAILABLE)("real render e2e canary (real marp-cli)", () => {
    it("renders a real PDF next to slides.md", () => {
      const repo = makeFixtureRepo();
      const started = Date.now();
      const r = runCli(["render", "presentations/demo-deck"], repo);
      const elapsedMs = Date.now() - started;
      console.log(`deckd CLI e2e render: ${elapsedMs}ms`);

      expect(r.status).toBe(0);
      const pdfPath = join(repo, "presentations", "demo-deck", "demo-deck.pdf");
      expect(existsSync(pdfPath)).toBe(true);
      expect(readFileSync(pdfPath).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }, 60_000);
  });
});
