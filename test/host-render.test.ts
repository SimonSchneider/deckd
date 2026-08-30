import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import {
  createHostRenderer,
  sanitizeKey,
  layoutMetricsMarkerId,
  parseLayoutMetrics,
  resolveMarpBinPath,
  MARP_CLI_VERSION,
} from "../src/host-render.js";
import type { SpawnFn } from "../src/host-render.js";
import { loadBundle, createBundleRef, type Bundle } from "../src/bundle.js";

// Builds a real, on-disk bundle (deckd.json + theme.css, and an assets dir unless
// opts.assets is false) loaded through the real loadBundle. Kept local to this
// file (rather than reusing test/helpers.ts's makeBundle) because these tests
// assert on the exact theme/asset content the scratch symlinks expose.
function makeFakeBundle(
  opts: { themeContent?: string; assets?: boolean; render?: Record<string, unknown> } = {},
): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "deckd-bundle-"));
  writeFileSync(join(dir, "theme.css"), opts.themeContent ?? "/* theme */");
  const manifest: Record<string, unknown> = { theme: "theme.css" };
  if (opts.assets !== false) {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "marker.txt"), "asset");
    manifest.assets = "assets";
  }
  if (opts.render !== undefined) manifest.render = opts.render;
  writeFileSync(join(dir, "deckd.json"), JSON.stringify(manifest));
  return loadBundle(dir);
}

function makeDeckDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckd-deck-"));
  writeFileSync(join(dir, "slides.md"), "---\nmarp: true\ntheme: sample\n---\n\n# Hi\n");
  mkdirSync(join(dir, "images"));
  writeFileSync(join(dir, "images", "logo.png"), "png-bytes");
  return dir;
}

function baseEnv(callsLog: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", CALLS_LOG: callsLog, ...extra };
}

// Single stub standing in for every real marp binary invocation host-render.ts makes
// (render's pdf, renderPreviews' pngs, checkLayout's html, the pptx pipeline's own
// html step) -- they're all the same binary now that render.sh is gone, dispatched
// here purely by the shape of the -o path. Injected via the marpBinPath override (see
// HostRendererOptions), under the literal string "npx" as this suite's own naming
// convention for "the stubbed marp binary" -- not the real npx tool, which
// host-render.ts no longer invokes at all. Refuses to run if charts.py leaked into
// the mirror next to the input slides.md (the one thing that must never reach the
// host).
const STUB_NPX = `#!/bin/bash
set -euo pipefail
echo "cmd=npx|cwd=$(pwd)|args=$*" >> "$CALLS_LOG"
out=""
prev=""
input=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in
    */slides.md) input="$a" ;;
  esac
  prev="$a"
done
if [ -n "$input" ]; then
  deck_dir="$(dirname "$input")"
  if [ -f "$deck_dir/charts.py" ]; then
    echo "charts.py must never reach the host" >&2
    exit 9
  fi
fi
if [ "\${FORCE_MARP_EXIT:-0}" != "0" ]; then
  echo "marp failed" >&2
  exit "$FORCE_MARP_EXIT"
fi
if [ "\${FORCE_MARP_SLEEP:-0}" != "0" ]; then
  sleep "$FORCE_MARP_SLEEP"
fi
mkdir -p "$(dirname "$out")"
case "$out" in
  *.pdf)
    echo "dummy-pdf" > "$out"
    echo "rendered $out"
    ;;
  *.png)
    base="\${out%.png}"
    n="\${PNG_COUNT:-3}"
    i=1
    while [ "$i" -le "$n" ]; do
      printf 'fake-png-%d' "$i" > "$(printf '%s.%03d.png' "$base" "$i")"
      i=$((i + 1))
    done
    echo "rendered $n png(s)"
    ;;
  *.html)
    printf '<!DOCTYPE html><html><body><section id="1">slide</section></body></html>' > "$out"
    echo "rendered check html"
    ;;
  *)
    echo "unrecognized -o path: $out" >&2
    exit 1
    ;;
esac
`;

function makeStubNpx(scratchRoot: string): string {
  const npx = join(scratchRoot, "stub-npx.sh");
  writeFileSync(npx, STUB_NPX);
  chmodSync(npx, 0o755);
  return npx;
}

// Wires the exec seam to the stub above whenever the command is this suite's "npx"
// placeholder (see STUB_NPX and the marpBinPath: "npx" test convention); any other
// command (e.g. "node", for the pptx pipeline's gen-pptx step) is passed through
// unchanged.
function makeFakeExec(npxScriptPath: string): SpawnFn {
  return (command, args, options) => {
    const script = command === "npx" ? npxScriptPath : command;
    return spawn(script, args, { cwd: options.cwd, env: options.env, detached: true });
  };
}

// Guards against MARP_CLI_VERSION drifting from the pinned dependency it documents:
// resolveMarpBinPath() no longer takes a version string (it resolves whatever
// @marp-team/marp-cli is actually installed), so nothing else would catch package.json
// and this constant disagreeing about which marp-cli build deckd is meant to run.
describe("MARP_CLI_VERSION pin", () => {
  it("matches the exact version package.json pins @marp-team/marp-cli to", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@marp-team/marp-cli"]).toBe(MARP_CLI_VERSION);
  });
});

describe("createHostRenderer", () => {
  it("mirrors the bundle theme+assets and deck, excludes charts.py, invokes marp, copies the pdf back", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    writeFileSync(join(deckDir, "charts.py"), "print('untrusted')");
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);

    const scratchDir = join(scratchRoot, sanitizeKey("s1:deck-a"));
    expect(readFileSync(join(scratchDir, "theme.css"), "utf8")).toBe("/* theme */");
    expect(existsSync(join(scratchDir, "assets", "marker.txt"))).toBe(true);

    const mirrorDir = join(scratchDir, "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "slides.md"))).toBe(true);
    expect(existsSync(join(mirrorDir, "images", "logo.png"))).toBe(true);
    expect(existsSync(join(mirrorDir, "charts.py"))).toBe(false);

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    // Compare via realpath: macOS resolves the tmpdir's /var -> /private/var symlink
    // when the child process actually chdir()s, which the literal scratchDir string
    // (built from mkdtempSync's unresolved return value) wouldn't otherwise match.
    expect(calls[0]).toContain(`cwd=${realpathSync(scratchDir)}`);
    expect(calls[0]).toContain("--theme theme.css");
    expect(calls[0]).toContain("presentations/my-deck/slides.md");
    expect(calls[0]).toContain("-o presentations/my-deck/my-deck.pdf");

    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(true);
    expect(readFileSync(join(deckDir, "my-deck.pdf"), "utf8")).toContain("dummy-pdf");
    expect(existsSync(join(deckDir, "my-deck-editable.pptx"))).toBe(false);
  });

  it("omits --pdf-outlines and --pdf-notes when the bundle's render config leaves them off (the default)", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls[0]).not.toContain("--pdf-outlines");
    expect(calls[0]).not.toContain("--pdf-notes");
  });

  it("appends --pdf-outlines and --pdf-notes to the pdf render when the bundle's render config enables them", async () => {
    const bundle = makeFakeBundle({ render: { pdfOutlines: true, pdfNotes: true } });
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls[0]).toContain("--pdf-outlines");
    expect(calls[0]).toContain("--pdf-notes");
  });

  it("fails a pptx export clearly when no chromePath is configured, after the pdf already succeeded", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true });

    expect(result.code).toBe(-1);
    expect(result.output).toContain("no chromePath configured for pptx export");
    // The pdf step ran (and succeeded) before the pptx step's chromePath check --
    // render() doesn't discard a working pdf just because the pptx export failed.
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(true);
    expect(existsSync(join(deckDir, "my-deck-editable.pptx"))).toBe(false);
  });

  // Regression: marp-cli detects an open-but-silent stdin and blocks waiting for
  // input ("Currently waiting data from stdin stream") instead of rendering. The
  // real spawn wiring (exercised here with no `exec` override -- only marpBinPath is
  // overridden, to point at this fixture script instead of the real installed
  // marp-cli) must give every command a closed stdin, or a command that probes stdin
  // the way marp-cli does hangs until the render timeout instead of completing.
  //
  // macOS's bash (3.2) reports the same exit status (1) for `read -t` whether stdin
  // hit EOF immediately or timed out waiting, so exit code can't distinguish the two
  // cases here — elapsed time is the only reliable signal: EOF is near-instant,
  // whereas a blocked read takes the full `read -t` duration.
  it("closes the child's stdin so a command that probes it doesn't hang", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const binDir = mkdtempSync(join(tmpdir(), "deckd-bin-"));
    const marpBinPath = join(binDir, "marp");
    writeFileSync(
      marpBinPath,
      `#!/bin/bash
set -uo pipefail
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
read -t 3 -r _line
echo "read-status=$?" >> "$CALLS_LOG"
mkdir -p "$(dirname "$out")"
echo "dummy-pdf" > "$out"
echo "rendered $out"
`,
    );
    chmodSync(marpBinPath, 0o755);

    // No `exec` override: this exercises the real defaultSpawn, not a test stub.
    // marpBinPath points straight at the fixture script above.
    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: { PATH: binDir, HOME: process.env.HOME ?? "/tmp", CALLS_LOG: callsLog },
      marpBinPath,
    });
    const started = Date.now();
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false, timeoutMs: 8000 });

    expect(result.code).toBe(0);
    // A blocked read takes the full 3s; a closed/EOF stdin returns in well under 1s.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(true);
  }, 10000);

  it("re-syncs the mirror on the next render: adds new files, drops stale links", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });

    await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "images", "logo.png"))).toBe(true);

    rmSync(join(deckDir, "images", "logo.png"));
    writeFileSync(join(deckDir, "notes.md"), "extra notes");

    await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });
    expect(existsSync(join(mirrorDir, "images", "logo.png"))).toBe(false);
    expect(existsSync(join(mirrorDir, "notes.md"))).toBe(true);
  });

  it("rejects a bad slug without touching the filesystem", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog) });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "Bad Slug!", pptx: false });

    expect(result.code).toBe(-1);
    expect(existsSync(callsLog)).toBe(false);
    expect(existsSync(join(scratchRoot, sanitizeKey("s1:deck-a")))).toBe(false);
  });

  it("surfaces a non-zero marp exit code with captured output", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog, { FORCE_MARP_EXIT: "3" }), exec: makeFakeExec(npx), marpBinPath: "npx" });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(3);
    expect(result.output).toContain("marp failed");
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(false);
  });

  it("kills the render on timeout", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog, { FORCE_MARP_SLEEP: "5" }), exec: makeFakeExec(npx), marpBinPath: "npx" });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false, timeoutMs: 200 });

    expect(result.code).toBe(-1);
    expect(result.output.toLowerCase()).toContain("timeout");
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(false);
  }, 10000);

  it("does not follow a pre-existing bad symlink left over from a previous bundle path", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const scratchDir = join(scratchRoot, sanitizeKey("s1:deck-a"));
    mkdirSync(scratchDir, { recursive: true });
    symlinkSync("/nonexistent/theme.css", join(scratchDir, "theme.css"));
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    expect(readFileSync(join(scratchDir, "theme.css"), "utf8")).toBe("/* theme */");
  });

  // A1: charts.py exclusion must not depend on exact-case matching (APFS/macOS paths
  // are case-insensitive), and no .py file belongs in the mirror at all — the mirror's
  // purpose is markdown + images.
  it("excludes charts.py case-insensitively and rejects any .py entry from the mirror", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    writeFileSync(join(deckDir, "Charts.py"), "print('untrusted')");
    writeFileSync(join(deckDir, "notes.py"), "print('also untrusted')");
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    const mirrored = readdirSync(mirrorDir);
    expect(mirrored).not.toContain("Charts.py");
    expect(mirrored).not.toContain("notes.py");
  });

  // A2: a deck entry that is itself a symlink must never be mirrored — mirroring it
  // lets an agent-controlled symlink read or write through to anywhere on the host.
  it("skips a deck entry that is itself a symlink and never mirrors it", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const outside = mkdtempSync(join(tmpdir(), "deckd-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(deckDir, "secret"));
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(readdirSync(mirrorDir)).not.toContain("secret");
    expect(() => lstatSync(join(mirrorDir, "secret"))).toThrow();
  });

  // A2: copy-back must never write through a pre-existing symlink at the destination —
  // an attacker could create `<slug>.pdf -> /anywhere/writable` in deckDir before rendering.
  it("replaces a pre-existing symlink at the pdf destination with a regular file after copy-back", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const outsideDir = mkdtempSync(join(tmpdir(), "deckd-outside-"));
    const outsideTarget = join(outsideDir, "escape.pdf");
    writeFileSync(outsideTarget, "should-not-be-touched");
    symlinkSync(outsideTarget, join(deckDir, "my-deck.pdf"));
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const dest = join(deckDir, "my-deck.pdf");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toContain("dummy-pdf");
    expect(readFileSync(outsideTarget, "utf8")).toBe("should-not-be-touched");
  });

  // A3: sanitizeKey alone collapses distinct raw keys ("a:b" and "a_b" both sanitize to
  // "a_b"), which would let two sessions race the same scratch dir.
  it("gives distinct scratch-dir names to raw keys that sanitize to the same string", () => {
    expect(sanitizeKey("a:b")).not.toBe(sanitizeKey("a_b"));
  });

  // HIGH: a manifest declaring its assets dir under a subdirectory named
  // "presentations" used to be linked into scratch under that same basename,
  // colliding with the mirror's own "presentations/<slug>" path. prepareScratch's
  // mirror mkdirSync then followed that link and wrote the deck mirror straight
  // into the bundle's own assets directory instead of a real scratch dir.
  it("does not follow a manifest assets dir named \"presentations\" into the bundle's own directory (HIGH structural collision)", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "deckd-bundle-collide-"));
    writeFileSync(join(bundleDir, "theme.css"), "/* theme */");
    mkdirSync(join(bundleDir, "shared", "presentations"), { recursive: true });
    writeFileSync(join(bundleDir, "shared", "presentations", "marker.txt"), "asset-marker");
    writeFileSync(join(bundleDir, "deckd.json"), JSON.stringify({ theme: "theme.css", assets: "shared/presentations" }));
    const bundle = loadBundle(bundleDir);

    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);

    // The bundle's own assets directory must gain no new entries: the deck mirror
    // must never land inside it.
    const assetsDir = bundle.assetsDir;
    expect(assetsDir).toBeDefined();
    if (assetsDir === undefined) throw new Error("unreachable: assets manifest entry was set above");
    expect(readdirSync(assetsDir).sort()).toEqual(["marker.txt"]);

    // The real scratch mirror lives at a real "presentations/<slug>" directory, not
    // a symlink into the bundle.
    const scratchDir = join(scratchRoot, sanitizeKey("s1:deck-a"));
    expect(lstatSync(join(scratchDir, "presentations")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(scratchDir, "presentations", "my-deck", "slides.md"))).toBe(true);

    // The bundle's assets are exposed under the fixed "assets" name instead.
    expect(lstatSync(join(scratchDir, "assets")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(scratchDir, "assets", "marker.txt"))).toBe(true);
  });

  // HIGH: same collision, but against the theme link's own fixed name -- a manifest
  // assets dir named "theme.css" used to clobber the theme symlink.
  it("does not let a manifest assets dir named \"theme.css\" clobber the theme link (HIGH structural collision)", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "deckd-bundle-collide-"));
    writeFileSync(join(bundleDir, "theme.css"), "/* real theme */");
    mkdirSync(join(bundleDir, "shared", "theme.css"), { recursive: true });
    writeFileSync(join(bundleDir, "shared", "theme.css", "marker.txt"), "asset-marker");
    writeFileSync(join(bundleDir, "deckd.json"), JSON.stringify({ theme: "theme.css", assets: "shared/theme.css" }));
    const bundle = loadBundle(bundleDir);

    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const scratchDir = join(scratchRoot, sanitizeKey("s1:deck-a"));
    // theme.css in scratch is still the real theme file -- not shadowed by the
    // assets directory.
    expect(lstatSync(join(scratchDir, "theme.css")).isDirectory()).toBe(false);
    expect(readFileSync(join(scratchDir, "theme.css"), "utf8")).toBe("/* real theme */");
    // Assets are exposed under the fixed "assets" name instead.
    expect(existsSync(join(scratchDir, "assets", "marker.txt"))).toBe(true);
  });

  // Coverage: proves the `../../assets/x` convention decks rely on (see
  // ensureBundleLinks's comment) actually resolves, by recomputing the same path
  // arithmetic marp would apply from the recorded invocation's cwd, and checking
  // the symlink layout backing it -- independent of the manifest's own assets
  // directory name (here "assets", the fixture's default).
  it("resolves ../../assets/<file> from the mirrored deck to the bundle's real assets dir", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });
    expect(result.code).toBe(0);

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("unreachable: exactly one call was logged");
    const cwdMatch = /cwd=([^|]+)/.exec(call);
    const cwd = cwdMatch?.[1];
    expect(cwd).toBeDefined();
    if (cwd === undefined) throw new Error("unreachable: the stub always logs its cwd");

    // presentations/<slug>/slides.md is the deck's location; ../../ from
    // presentations/<slug> is the marp process's own cwd (the scratch dir).
    const resolvedFromConvention = resolve(cwd, "presentations", "my-deck", "..", "..", "assets", "marker.txt");
    const scratchDir = realpathSync(join(scratchRoot, sanitizeKey("s1:deck-a")));
    expect(resolvedFromConvention).toBe(join(scratchDir, "assets", "marker.txt"));
    expect(existsSync(resolvedFromConvention)).toBe(true);
    expect(readFileSync(resolvedFromConvention, "utf8")).toBe("asset");

    // Backing layout: a fixed-named "assets" symlink in scratch pointing at the
    // bundle's real assets dir, independent of the manifest's own directory name.
    const assetsLink = join(scratchRoot, sanitizeKey("s1:deck-a"), "assets");
    expect(lstatSync(assetsLink).isSymbolicLink()).toBe(true);
    const assetsDir = bundle.assetsDir;
    expect(assetsDir).toBeDefined();
    if (assetsDir === undefined) throw new Error("unreachable: makeFakeBundle defaults assets to present");
    expect(realpathSync(assetsLink)).toBe(realpathSync(assetsDir));
  });
});

// Mirrors the shape the vendored native-pptx exporter emits: a full 1pt grid and a
// zero row height (see pptx-table-fix.test.ts's fixture builders, which this
// duplicates in miniature rather than importing, since the two suites should be free
// to drift the exact shape of their own fixtures independently).
const UNFIXED_TABLE_SLIDE_XML =
  `<p:sld><p:cSld><p:spTree>` +
  `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="1"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
  `<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1000"/></a:tblGrid>` +
  `<a:tr h="0"><a:tc><a:txBody><a:p><a:r><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr>` +
  `<a:lnL w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnL>` +
  `<a:lnR w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnR>` +
  `<a:lnT w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnT>` +
  `<a:lnB w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnB>` +
  `</a:tcPr></a:tc></a:tr>` +
  `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
  `</p:spTree></p:cSld></p:sld>`;

// Stands in for gen-pptx.js's real output: a minimal, valid pptx zip carrying one
// "ppt/slides/slide1.xml" entry with an unfixed table, so the pipeline's real (never
// stubbed) fixPptxTables() call has something genuine to restyle.
async function makeFixturePptx(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/slides/slide1.xml", UNFIXED_TABLE_SLIDE_XML);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
}

// Stands in for the vendored gen-pptx.js CLI (see HostRendererOptions.genPptxPath):
// logs its own invocation (argv order + the chromePath forwarded as its 3rd
// argument) to CALLS_LOG, then either fails (FORCE_GENPPTX_EXIT), writes unparseable
// garbage (FORCE_GENPPTX_GARBAGE, to exercise fixPptxTables' own failure path), or
// copies fixturePptxPath to the requested output -- never needing puppeteer-core, a
// real browser, or even the real vendored file at all.
function makeStubGenPptx(scratchRoot: string, fixturePptxPath: string): string {
  const script = join(scratchRoot, "stub-gen-pptx.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const [, , htmlPath, outPath, chromePath] = process.argv;
fs.appendFileSync(process.env.CALLS_LOG, \`cmd=gen-pptx|html=\${htmlPath}|out=\${outPath}|chrome=\${chromePath}\\n\`);
if (process.env.FORCE_GENPPTX_EXIT && process.env.FORCE_GENPPTX_EXIT !== "0") {
  process.stderr.write("gen-pptx failed\\n");
  process.exit(Number(process.env.FORCE_GENPPTX_EXIT));
}
if (process.env.FORCE_GENPPTX_GARBAGE === "1") {
  fs.writeFileSync(outPath, "not a zip");
} else {
  fs.copyFileSync(${JSON.stringify(fixturePptxPath)}, outPath);
}
`,
  );
  return script;
}

describe("createHostRenderer.render pptx export", () => {
  it("runs marp html -> gen-pptx -> table fix -> copies the pptx back, in order, removing the transient html from the mirror", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const fixturePptx = join(scratchRoot, "fixture-unfixed.pptx");
    await makeFixturePptx(fixturePptx);
    const genPptxPath = makeStubGenPptx(scratchRoot, fixturePptx);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx),
      marpBinPath: "npx",
      genPptxPath,
      chromePath: "/fake/chrome-for-pptx",
    });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true });

    expect(result.code).toBe(0);

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    // [0] marp -> pdf (render()'s own first step), [1] marp -> html, [2] gen-pptx.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("cmd=npx|");
    expect(calls[0]).toContain("-o presentations/my-deck/my-deck.pdf");
    expect(calls[1]).toContain("cmd=npx|");
    expect(calls[1]).toContain("-o presentations/my-deck/my-deck.html");
    expect(calls[2]).toContain("cmd=gen-pptx|");
    expect(calls[2]).toContain("chrome=/fake/chrome-for-pptx");

    // The transient html is never copied to deckDir, and is cleaned up from the
    // mirror once the pptx pipeline finishes with it.
    expect(existsSync(join(deckDir, "my-deck.html"))).toBe(false);
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "my-deck.html"))).toBe(false);

    // The pptx that reached deckDir already has fixPptxTables' correction applied --
    // not gen-pptx's raw (stubbed) output.
    const pptxPath = join(deckDir, "my-deck-editable.pptx");
    expect(existsSync(pptxPath)).toBe(true);
    const zip = await JSZip.loadAsync(readFileSync(pptxPath));
    const slideXml = await zip.file("ppt/slides/slide1.xml")?.async("string");
    expect(slideXml).toContain('<a:lnL w="12700"><a:noFill/></a:lnL>');
    expect(slideXml).toContain("1D1C30");
    expect(slideXml).not.toContain('h="0"');

    // The pdf render this job also always performs still landed too.
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(true);
  });

  it("surfaces a gen-pptx failure clearly, without copying a pptx back, keeping the already-rendered pdf", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const fixturePptx = join(scratchRoot, "fixture-unfixed.pptx");
    await makeFixturePptx(fixturePptx);
    const genPptxPath = makeStubGenPptx(scratchRoot, fixturePptx);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_GENPPTX_EXIT: "5" }),
      exec: makeFakeExec(npx),
      marpBinPath: "npx",
      genPptxPath,
      chromePath: "/fake/chrome-for-pptx",
    });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true });

    expect(result.code).toBe(5);
    expect(result.output).toContain("gen-pptx failed");
    expect(existsSync(join(deckDir, "my-deck-editable.pptx"))).toBe(false);
    expect(existsSync(join(deckDir, "my-deck.pdf"))).toBe(true);
  });

  it("surfaces a table-fix failure clearly when gen-pptx's output isn't a valid pptx, without copying a pptx back", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    const fixturePptx = join(scratchRoot, "fixture-unfixed.pptx");
    await makeFixturePptx(fixturePptx);
    const genPptxPath = makeStubGenPptx(scratchRoot, fixturePptx);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_GENPPTX_GARBAGE: "1" }),
      exec: makeFakeExec(npx),
      marpBinPath: "npx",
      genPptxPath,
      chromePath: "/fake/chrome-for-pptx",
    });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true });

    expect(result.code).toBe(-1);
    expect(result.output).toContain("table fix failed");
    expect(existsSync(join(deckDir, "my-deck-editable.pptx"))).toBe(false);
  });

  // Returns true if a process with this pid is still alive: signal 0 sends no
  // actual signal, only checks deliverability (throws ESRCH once the process is
  // reaped). Not a race-free check in general, but sufficient here: this only ever
  // runs after render() has already resolved, well after the SIGKILL was sent.
  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // A1 regression: @puppeteer/browsers launches Chrome with `detached: true` on
  // non-Windows, with no supported way to override that through puppeteer-core's
  // public launch() API (see vendor/marp-to-editable-pptx/README.md's "local
  // deviations" note) -- so gen-pptx's real Chrome always becomes the leader of its
  // OWN process group, one level detached from gen-pptx's own group. Before the
  // fix, host-render's timeout only SIGKILLed gen-pptx's group, leaving that
  // detached Chrome running forever. This stub simulates exactly that shape: it
  // spawns a real, detached, long-lived child (standing in for Chrome) and prints
  // the same "[deckd] chrome-pid: N" marker the vendored launch prints, then hangs.
  it("A1: kills gen-pptx's detached Chrome, not just gen-pptx's own process group, on timeout", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const chromeStubPath = join(scratchRoot, "stub-chrome-hang.sh");
    writeFileSync(chromeStubPath, `#!/bin/bash\nwhile true; do sleep 1; done\n`);
    chmodSync(chromeStubPath, 0o755);
    const chromePidFile = join(scratchRoot, "chrome.pid");

    const genPptxPath = join(scratchRoot, "stub-gen-pptx-hang.cjs");
    writeFileSync(
      genPptxPath,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const chrome = spawn(${JSON.stringify(chromeStubPath)}, [], { detached: true, stdio: "ignore" });
chrome.unref();
fs.writeFileSync(${JSON.stringify(chromePidFile)}, String(chrome.pid));
console.log(\`[deckd] chrome-pid: \${chrome.pid}\`);
setInterval(() => {}, 1000);
`,
    );

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx),
      marpBinPath: "npx",
      genPptxPath,
      chromePath: "/fake/chrome-for-pptx",
    });

    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true, timeoutMs: 500 });

    expect(result.code).toBe(-1);
    expect(result.output.toLowerCase()).toContain("timeout");

    // A SIGKILLed orphan can sit briefly as a zombie before its new (launchd/init)
    // parent reaps it, during which kill(pid, 0) still reports it as present --
    // give that a moment rather than asserting in the same tick the signal was sent.
    await new Promise((r) => setTimeout(r, 300));
    const chromePid = Number(readFileSync(chromePidFile, "utf8"));
    expect(chromePid).toBeGreaterThan(0);
    expect(isPidAlive(chromePid)).toBe(false);
  }, 10000);

  // B5 regression: renderPptxArtifact threads ONE shared deadlineAt through its own
  // marp-html step and its gen-pptx step (see render()'s single `deadlineAt` passed
  // down), rather than each step getting a fresh full timeoutMs of its own. Proven
  // here by making the first two stages (pdf, html -- both the same stubbed marp
  // binary) each eat a known chunk of the budget, then hanging the last stage
  // (gen-pptx) forever: if the deadline weren't shared, gen-pptx's own runProcess
  // call would time out after a fresh full `timeoutMs` measured from when IT
  // started, well past the job's own original timeoutMs.
  it("B5: gen-pptx's own timeout is what's left of the shared deadline, not a fresh full budget", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const stageStarts: number[] = [];
    const timing = makeFakeExec(npx);
    const timingExec: SpawnFn = (command, args, options) => {
      stageStarts.push(Date.now());
      return timing(command, args, options);
    };

    const genPptxPath = join(scratchRoot, "stub-gen-pptx-hang.cjs");
    writeFileSync(genPptxPath, `setInterval(() => {}, 1000);\n`);

    const timeoutMs = 1200;
    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      // Each of the two marp stages (pdf, html) sleeps 300ms, eating 600ms of the
      // shared 1200ms budget before gen-pptx even starts.
      env: baseEnv(callsLog, { FORCE_MARP_SLEEP: "0.3" }),
      exec: timingExec,
      marpBinPath: "npx",
      genPptxPath,
      chromePath: "/fake/chrome-for-pptx",
    });

    const started = Date.now();
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: true, timeoutMs });
    const elapsed = Date.now() - started;

    expect(result.code).toBe(-1);
    expect(result.output.toLowerCase()).toContain("timeout");

    // Three exec calls: pdf, html, gen-pptx -- each genuinely starting later than
    // the last, which is what gives the shrinking deadline something to measure.
    expect(stageStarts).toHaveLength(3);
    expect(stageStarts[1]).toBeGreaterThan(stageStarts[0] ?? 0);
    expect(stageStarts[2]).toBeGreaterThan(stageStarts[1] ?? 0);
    // Shared deadline: total elapsed stays close to the job's own timeoutMs (the
    // 600ms the first two stages spent comes out of gen-pptx's remaining budget,
    // not on top of it). A fresh-budget-per-stage regression would instead take
    // ~600ms + a full 1200ms more for gen-pptx alone -- comfortably past this bound.
    expect(elapsed).toBeLessThan(timeoutMs * 1.5);
  }, 10000);
});

describe("createHostRenderer.renderPreviews", () => {
  it("produces one PNG per slide and copies them into deckDir/preview in order", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { PNG_COUNT: "3" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    expect(result.pngs).toEqual([
      join(deckDir, "preview", "my-deck.001.png"),
      join(deckDir, "preview", "my-deck.002.png"),
      join(deckDir, "preview", "my-deck.003.png"),
    ]);
    for (const [i, p] of result.pngs.entries()) {
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(`fake-png-${i + 1}`);
    }

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("cmd=npx|");
    expect(calls[0]).toContain("--images png");
    expect(calls[0]).toContain(`presentations/my-deck/preview/my-deck.png`);
    // imageScale defaults to 2 even with no render block declared at all -- agent-facing
    // crispness in get_slide_previews; humans read the vector PDF, unaffected.
    expect(calls[0]).toContain("--image-scale 2");
  });

  it("uses the bundle's configured imageScale for --image-scale instead of the default", async () => {
    const bundle = makeFakeBundle({ render: { imageScale: 3.5 } });
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls[0]).toContain("--image-scale 3.5");
  });

  it("clears stale preview PNGs from a previous run before copying the new ones, leaving other files in preview/ alone", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    mkdirSync(join(deckDir, "preview"), { recursive: true });
    writeFileSync(join(deckDir, "preview", "my-deck.001.png"), "stale-1");
    writeFileSync(join(deckDir, "preview", "my-deck.002.png"), "stale-2");
    writeFileSync(join(deckDir, "preview", "my-deck.003.png"), "stale-3");
    writeFileSync(join(deckDir, "preview", "ghost.txt"), "unrelated leftover");

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { PNG_COUNT: "1" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    const entries = readdirSync(join(deckDir, "preview")).sort();
    // Only entries matching the rendered-PNG naming pattern are cleared; a file a
    // deck placed in preview/ itself is not swept away by the stale-clear.
    expect(entries).toEqual(["ghost.txt", "my-deck.001.png"]);
    expect(readFileSync(join(deckDir, "preview", "my-deck.001.png"), "utf8")).toBe("fake-png-1");
    expect(readFileSync(join(deckDir, "preview", "ghost.txt"), "utf8")).toBe("unrelated leftover");
  });

  // mkdirSync({recursive:true}) does not throw when destDir is a symlink to an
  // existing directory, and readdir/rm both follow it — so an attacker-created symlink at
  // deckDir/preview pointing at any host directory would turn the stale-clear and copy
  // into writes against that directory instead of a real preview/ under deckDir.
  it("replaces a pre-existing symlink at deckDir/preview with a real directory, leaving the old target untouched", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const outsideDir = mkdtempSync(join(tmpdir(), "deckd-outside-preview-"));
    writeFileSync(join(outsideDir, "keep.txt"), "should not be touched");
    symlinkSync(outsideDir, join(deckDir, "preview"));

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { PNG_COUNT: "2" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    const destDir = join(deckDir, "preview");
    expect(lstatSync(destDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(destDir).isDirectory()).toBe(true);
    expect(readdirSync(destDir).sort()).toEqual(["my-deck.001.png", "my-deck.002.png"]);
    expect(readdirSync(outsideDir)).toEqual(["keep.txt"]);
    expect(readFileSync(join(outsideDir, "keep.txt"), "utf8")).toBe("should not be touched");
  });

  // The preview/ dir copied back into deckDir is renderPreviews' own derived output,
  // not deck content, and must not be re-mirrored into the scratch dir on the next
  // render — otherwise it would be treated as source and grow without bound.
  it("does not mirror deckDir's preview/ directory into the scratch mirror", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    mkdirSync(join(deckDir, "preview"), { recursive: true });
    writeFileSync(join(deckDir, "preview", "my-deck.001.png"), "leftover-from-a-previous-run");

    const renderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot, env: baseEnv(callsLog), exec: makeFakeExec(npx), marpBinPath: "npx" });
    const result = await renderer.render({ key: "s1:deck-a", deckDir, slug: "my-deck", pptx: false });

    expect(result.code).toBe(0);
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "preview"))).toBe(false);
  });

  // Same exclusions render() enforces (charts.py, case-insensitively, and symlinked
  // deck entries) must hold for renderPreviews too — it shares the same mirror setup.
  it("keeps the charts.py and symlink exclusions for renderPreviews", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const outside = mkdtempSync(join(tmpdir(), "deckd-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(deckDir, "secret"));
    writeFileSync(join(deckDir, "Charts.py"), "print('untrusted')");
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { PNG_COUNT: "1" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    const mirrored = readdirSync(mirrorDir);
    expect(mirrored).not.toContain("Charts.py");
    expect(mirrored).not.toContain("secret");
    expect(() => lstatSync(join(mirrorDir, "secret"))).toThrow();
  });

  it("rejects a bad slug without touching the filesystem", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "Bad Slug!" });

    expect(result.code).toBe(-1);
    expect(result.pngs).toEqual([]);
    expect(existsSync(callsLog)).toBe(false);
    expect(existsSync(join(scratchRoot, sanitizeKey("s1:deck-a")))).toBe(false);
  });

  it("surfaces a non-zero marp exit code with captured output and no copied pngs", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_MARP_EXIT: "5" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(5);
    expect(result.output).toContain("marp failed");
    expect(result.pngs).toEqual([]);
    expect(existsSync(join(deckDir, "preview"))).toBe(false);
  });

  it("kills the marp process and reports a timeout, leaving prior previews untouched", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const npx = makeStubNpx(scratchRoot);
    mkdirSync(join(deckDir, "preview"), { recursive: true });
    writeFileSync(join(deckDir, "preview", "my-deck.001.png"), "kept-from-before");

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_MARP_SLEEP: "5" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
    });
    const result = await renderer.renderPreviews({ key: "s1:deck-a", deckDir, slug: "my-deck", timeoutMs: 200 });

    expect(result.code).toBe(-1);
    expect(result.output.toLowerCase()).toContain("timeout");
    expect(result.pngs).toEqual([]);
    expect(readFileSync(join(deckDir, "preview", "my-deck.001.png"), "utf8")).toBe("kept-from-before");
  }, 10000);
});

// Stub for the injectable chromePath binary. Doesn't actually load or execute the HTML
// file the way real Chrome would (there's no real DOM/layout here), but it does read
// the marker id real injectLayoutMetricsScript wrote into that file's injected script,
// and echoes the dumped-DOM stdout back with that same (per-call, nonce-scoped) id --
// this is what lets a test dictate exactly which slides "overflow" via CHROME_METRICS_JSON,
// while still exercising the real nonce end-to-end (checkLayout generates it,
// injectLayoutMetricsScript writes it into the file, this stub reads it back out, and
// parseLayoutMetrics must find it again). Optional CHROME_FILLER_BYTES prepends that many
// junk bytes before the marker, standing in for a real deck's huge embedded content
// (base64 fonts/images) to exercise runChromeDump's bounded tail.
const STUB_CHROME = `#!/bin/bash
set -euo pipefail
echo "cmd=chrome|cwd=$(pwd)|args=$*" >> "$CALLS_LOG"
if [ "\${FORCE_CHROME_SLEEP:-0}" != "0" ]; then
  sleep "$FORCE_CHROME_SLEEP"
fi
if [ "\${FORCE_CHROME_EXIT:-0}" != "0" ]; then
  echo "chrome failed" >&2
  exit "$FORCE_CHROME_EXIT"
fi
html_url="\${*: -1}"
html_path="\${html_url#file://}"
marker_id=$(grep -o 'marker\\.id = "[^"]*"' "$html_path" | sed -E 's/.*"(.*)"/\\1/')
echo "marker_id=$marker_id" >> "$CALLS_LOG"
if [ "\${CHROME_FILLER_BYTES:-0}" != "0" ]; then
  head -c "$CHROME_FILLER_BYTES" /dev/zero | tr '\\0' 'x'
fi
printf '<!DOCTYPE html><html><body><div id="%s">%s</div></body></html>' "$marker_id" "\${CHROME_METRICS_JSON:-[]}"
`;

function makeCheckLayoutStubs(scratchRoot: string): { npx: string; chrome: string } {
  const npx = makeStubNpx(scratchRoot);
  const chrome = join(scratchRoot, "stub-chrome.sh");
  writeFileSync(chrome, STUB_CHROME);
  chmodSync(chrome, 0o755);
  return { npx, chrome };
}

describe("createHostRenderer.checkLayout", () => {
  it("reports no issues for a clean deck", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);
    const metrics = JSON.stringify([
      { slide: 1, overflowY: 0, overflowX: 0 },
      { slide: 2, overflowY: 0, overflowX: 0 },
    ]);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: metrics }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    expect(result.issues).toEqual([]);

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("cmd=npx|");
    expect(calls[0]).toContain("presentations/my-deck/preview/my-deck-check.html");
    expect(calls[1]).toContain("cmd=chrome|");
    expect(calls[2]).toMatch(/^marker_id=deckd-layout-metrics-[0-9a-f-]{36}$/);
    expect(calls[1]).toContain("--dump-dom");
  });

  // checkLayout is DOM-metric based (dump-dom, no rendered images), so imageScale --
  // which only ever affects renderPreviews' PNGs -- must never leak into its marp
  // invocation, even when the bundle configures a non-default scale.
  it("never appends --image-scale to the layout-check marp invocation", async () => {
    const bundle = makeFakeBundle({ render: { imageScale: 3 } });
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: "[]" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls[0]).not.toContain("--image-scale");
  });

  // Guards against a marp-cli DOM-structure change silently zeroing the check: a
  // real deck always has at least one top-level slide section, so zero measured
  // sections means the check didn't measure anything, not that the deck is clean.
  it("errors clearly instead of reporting a clean deck when zero slide sections are measured", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: "[]" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(-1);
    expect(result.issues).toEqual([]);
    expect(result.output).toContain("zero slide sections");
  });

  it("reports an overflow-y issue with the measured amount for the overflowing slide only", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);
    const metrics = JSON.stringify([
      { slide: 1, overflowY: 0, overflowX: 0 },
      { slide: 2, overflowY: 40, overflowX: 0 },
    ]);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: metrics }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(0);
    expect(result.issues).toEqual([{ slide: 2, kind: "overflow-y", amountPx: 40 }]);
  });

  it("reports an overflow-x issue distinctly from overflow-y", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);
    const metrics = JSON.stringify([{ slide: 1, overflowY: 0, overflowX: 12 }]);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: metrics }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.issues).toEqual([{ slide: 1, kind: "overflow-x", amountPx: 12 }]);
  });

  it("tolerates up to 2px of slack as rounding noise, not an issue", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);
    const metrics = JSON.stringify([
      { slide: 1, overflowY: 2, overflowX: 0 },
      { slide: 2, overflowY: 3, overflowX: 0 },
    ]);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: metrics }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.issues).toEqual([{ slide: 2, kind: "overflow-y", amountPx: 3 }]);
  });

  it("deletes the check HTML from the mirror after a successful run", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: JSON.stringify([{ slide: 1, overflowY: 0, overflowX: 0 }]) }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "preview", "my-deck-check.html"))).toBe(false);
    // The transient check artifact must never leak back into the deck's own directory.
    expect(existsSync(join(deckDir, "preview"))).toBe(false);
  });

  it("surfaces a chrome failure as a non-zero code with no issues, and still deletes the check HTML", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_CHROME_EXIT: "7" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(7);
    expect(result.issues).toEqual([]);
    expect(result.output).toContain("chrome failed");
    const mirrorDir = join(scratchRoot, sanitizeKey("s1:deck-a"), "presentations", "my-deck");
    expect(existsSync(join(mirrorDir, "preview", "my-deck-check.html"))).toBe(false);
  });

  it("returns code -1 clearly when no chromePath is configured, without invoking marp", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      // chromePath intentionally omitted
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(-1);
    expect(result.issues).toEqual([]);
    expect(existsSync(callsLog)).toBe(false);
  });

  it("surfaces a marp failure without invoking chrome", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_MARP_EXIT: "4" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    expect(result.code).toBe(4);
    expect(result.issues).toEqual([]);
    expect(result.output).toContain("marp failed");
    const calls = readFileSync(callsLog, "utf8").trim().split("\n");
    expect(calls.some((c) => c.includes("cmd=chrome|"))).toBe(false);
  });

  it("rejects a bad slug without touching the filesystem", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "Bad Slug!" });

    expect(result.code).toBe(-1);
    expect(result.issues).toEqual([]);
    expect(existsSync(callsLog)).toBe(false);
  });

  it("kills chrome on timeout and reports it clearly", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { FORCE_CHROME_SLEEP: "5" }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck", timeoutMs: 500 });

    expect(result.code).toBe(-1);
    expect(result.output.toLowerCase()).toContain("timeout");
    expect(result.issues).toEqual([]);
  }, 10000);

  // The marker id is a per-invocation nonce (crypto.randomUUID()), not a fixed string
  // -- otherwise deck markdown (marp --html) could forge a marker with a known id and
  // have it extracted as the real measurement. Two calls must never reuse an id.
  it("uses a fresh marker nonce on every call, never the same id twice", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: JSON.stringify([{ slide: 1, overflowY: 0, overflowX: 0 }]) }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });
    await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck" });

    const markerIds = readFileSync(callsLog, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("marker_id="))
      .map((l) => l.slice("marker_id=".length));
    expect(markerIds).toHaveLength(2);
    expect(markerIds[0]).toMatch(/^deckd-layout-metrics-[0-9a-f-]{36}$/);
    expect(markerIds[1]).toMatch(/^deckd-layout-metrics-[0-9a-f-]{36}$/);
    expect(markerIds[0]).not.toBe(markerIds[1]);
  });

  // runChromeDump keeps only the last CHROME_DUMP_MAX_BYTES (32MB) of stdout as chunks
  // arrive, rather than buffering an unbounded amount of an agent-authored deck's own
  // embedded content (giant inline SVGs, base64 fonts/images). The marker is always
  // appended last, so it must still be found even once the filler pushes the dump well
  // past that cap.
  it("still finds the marker after 40MB of filler content pushes the dump past the 32MB cap", async () => {
    const bundle = makeFakeBundle();
    const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-scratch-"));
    const deckDir = makeDeckDir();
    const callsLog = join(scratchRoot, "calls.log");
    const { npx, chrome } = makeCheckLayoutStubs(scratchRoot);
    const metrics = JSON.stringify([{ slide: 1, overflowY: 40, overflowX: 0 }]);

    const renderer = createHostRenderer({
      bundleRef: createBundleRef(bundle),
      scratchRoot,
      env: baseEnv(callsLog, { CHROME_METRICS_JSON: metrics, CHROME_FILLER_BYTES: String(40 * 1024 * 1024) }),
      exec: makeFakeExec(npx), marpBinPath: "npx",
      chromePath: chrome,
    });
    const result = await renderer.checkLayout({ key: "s1:deck-a", deckDir, slug: "my-deck", timeoutMs: 30000 });

    expect(result.code).toBe(0);
    expect(result.issues).toEqual([{ slide: 1, kind: "overflow-y", amountPx: 40 }]);
  }, 30000);
});

// Pure unit tests for the marker-extraction logic itself: no chrome/marp involved,
// just fixture "dumped DOM" strings handed straight to parseLayoutMetrics.
describe("parseLayoutMetrics", () => {
  const nonceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nonceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("extracts the marker matching the given nonce", () => {
    const real = [{ slide: 1, overflowY: 40, overflowX: 0 }];
    const dumped = `<html><body><div id="${layoutMetricsMarkerId(nonceA)}">${JSON.stringify(real)}</div></body></html>`;

    expect(parseLayoutMetrics(dumped, nonceA)).toEqual([{ slide: 1, kind: "overflow-y", amountPx: 40 }]);
  });

  // The core exploit this defends against: deck markdown can contain raw HTML
  // (marp --html), including a forged `<div id="deckd-layout-metrics">...</div>` using
  // the pre-nonce static id. The first-match-wins regex used to let that forged content
  // override the real measurement; requiring this call's own nonce in the id makes the
  // forged element simply not match at all.
  it("ignores a spoofed marker using the old static id, and extracts only the real nonce-scoped one", () => {
    const spoofed = `<div id="deckd-layout-metrics">${JSON.stringify([{ slide: 1, overflowY: 999, overflowX: 999 }])}</div>`;
    const real = [{ slide: 2, overflowY: 40, overflowX: 0 }];
    const dumped = `<html><body>${spoofed}<div id="${layoutMetricsMarkerId(nonceA)}">${JSON.stringify(real)}</div></body></html>`;

    expect(parseLayoutMetrics(dumped, nonceA)).toEqual([{ slide: 2, kind: "overflow-y", amountPx: 40 }]);
  });

  // Same idea, but the forged marker also uses the real-format id -- guessing another
  // call's nonce (or replaying an old one) still doesn't match this call's own.
  it("ignores a marker scoped to a different nonce", () => {
    const dumped = `<div id="${layoutMetricsMarkerId(nonceB)}">${JSON.stringify([{ slide: 1, overflowY: 999, overflowX: 0 }])}</div>`;

    expect(() => parseLayoutMetrics(dumped, nonceA)).toThrow(/layout-metrics marker/);
  });

  // Belt and braces on top of the nonce: if more than one marker for this call's own
  // nonce somehow ends up in the dump (e.g. a deck script that removes and re-adds it
  // under --virtual-time-budget), the last one -- ours, appended last -- wins.
  it("takes the last marker when more than one matches this call's nonce", () => {
    const first = JSON.stringify([{ slide: 1, overflowY: 999, overflowX: 0 }]);
    const second = JSON.stringify([{ slide: 1, overflowY: 0, overflowX: 0 }]);
    const dumped =
      `<div id="${layoutMetricsMarkerId(nonceA)}">${first}</div>` + `<div id="${layoutMetricsMarkerId(nonceA)}">${second}</div>`;

    expect(parseLayoutMetrics(dumped, nonceA)).toEqual([]);
  });

  it("throws a distinct error for a marker whose payload isn't valid JSON, not a generic parse error", () => {
    const dumped = `<div id="${layoutMetricsMarkerId(nonceA)}">not valid json{</div>`;

    expect(() => parseLayoutMetrics(dumped, nonceA)).toThrow("layout metrics marker unparseable");
  });

  it("throws when the nonce's marker is missing entirely", () => {
    expect(() => parseLayoutMetrics("<html><body></body></html>", nonceA)).toThrow(
      "chrome dump-dom output did not contain the layout-metrics marker",
    );
  });

  it("throws clearly when the marker's array is empty (zero measured sections)", () => {
    const dumped = `<div id="${layoutMetricsMarkerId(nonceA)}">[]</div>`;

    expect(() => parseLayoutMetrics(dumped, nonceA)).toThrow(/zero slide sections/);
  });
});

// Whether the pinned @marp-team/marp-cli dependency actually resolves to an
// installed binary -- host-render.ts hasn't invoked npx since resolveMarpBinPath
// replaced it, so an `npx` on PATH neither implies nor is required for the real
// toolchain being available here.
function marpBinAvailable(): boolean {
  try {
    resolveMarpBinPath();
    return true;
  } catch {
    return false;
  }
}

const E2E_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const E2E_AVAILABLE = existsSync(E2E_CHROME_PATH) && marpBinAvailable();

// The real theme content this bundle carries -- no build step involved (deckd
// consumes a prebuilt theme.css directly), so this is just written straight into
// the fixture bundle.
const E2E_THEME_CSS = "/* @theme sample */\nsection { background: white; font-size: 28px; }\n";

function makeE2eBundle(): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "deckd-e2e-bundle-"));
  writeFileSync(join(dir, "theme.css"), E2E_THEME_CSS);
  writeFileSync(join(dir, "deckd.json"), JSON.stringify({ theme: "theme.css" }));
  return loadBundle(dir);
}

const E2E_OVERFLOW_CONTENT = Array.from({ length: 40 }, (_, i) => `overflow line ${i + 1}`).join("\n\n");

// Slide 2 is 40 lines of body content in a 28px-font 720px-tall slide box: real,
// deliberate overflow, not simulated. Slide 2 also carries the nested-<section> raw
// HTML (which must not shift its own slide number, nor appear as a 4th "slide" of
// its own) -- placed on the overflowing slide itself, not a neighboring one, so
// that any numbering drift the injection caused would misattribute the overflow to
// the wrong slide and fail this test, rather than land somewhere the assertion
// below can't see it. Slide 3 carries only the spoofed marker div claiming zero
// overflow everywhere, which must not be what gets extracted.
const E2E_SLIDES_MD = `---
marp: true
theme: sample
paginate: true
---

# Slide 1

content

---

# Slide 2 (deliberately overflows)

${E2E_OVERFLOW_CONTENT}

<section>nested section injected via raw HTML -- must not shift slide numbering</section>

---

# Slide 3

<div id="deckd-layout-metrics">${JSON.stringify([
  { slide: 1, overflowY: 0, overflowX: 0 },
  { slide: 2, overflowY: 0, overflowX: 0 },
  { slide: 3, overflowY: 0, overflowX: 0 },
])}</div>
`;

// E2E CANARY: the only test in this file that runs the real pipeline end to end (real
// `npx @marp-team/marp-cli`, real headless Chrome -- no stubs at all). Every other
// checkLayout test stubs chrome and/or marp, so none of them exercises Chrome's real
// DOM structure or a deck's own raw HTML content against the extraction logic -- this
// is the only test that would catch a marker-spoofing or slide-numbering regression in
// that logic. Skipped when Chrome/npx aren't on this machine; kept as its own describe
// so a skip is visible in the test list rather than silently absent.
describe.skipIf(!E2E_AVAILABLE)("createHostRenderer.checkLayout e2e canary (real marp-cli + real Chrome)", () => {
  it(
    "reports the real overflow on the correct slide number, with no spoofed values from the deck's own raw HTML",
    async () => {
      const bundle = makeE2eBundle();
      const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-e2e-scratch-"));
      const deckDir = makeDeckDir();
      writeFileSync(join(deckDir, "slides.md"), E2E_SLIDES_MD);

      const renderer = createHostRenderer({
        bundleRef: createBundleRef(bundle),
        scratchRoot,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        chromePath: E2E_CHROME_PATH,
      });

      const result = await renderer.checkLayout({ key: "e2e:probe", deckDir, slug: "my-deck", timeoutMs: 100_000 });

      expect(result.code).toBe(0);
      expect(result.issues).toHaveLength(1);
      const issue = result.issues[0];
      expect(issue?.slide).toBe(2);
      expect(issue?.kind).toBe("overflow-y");
      // The spoofed marker in the deck's own raw HTML claims 0px of overflow on every
      // slide; the real measurement is not that.
      expect(issue?.amountPx).toBeGreaterThan(2);
    },
    120_000,
  );
});

const E2E_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#2b6"/></svg>\n';

function makeE2eBundleWithAssets(): Bundle {
  const dir = mkdtempSync(join(tmpdir(), "deckd-e2e-bundle-"));
  writeFileSync(join(dir, "theme.css"), E2E_THEME_CSS);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "logo.svg"), E2E_LOGO_SVG);
  writeFileSync(join(dir, "deckd.json"), JSON.stringify({ theme: "theme.css", assets: "assets" }));
  return loadBundle(dir);
}

const E2E_ASSET_SLIDES_MD = `---
marp: true
theme: sample
---

# Slide referencing a bundle asset

![width:100px](../../assets/logo.svg)
`;

// E2E CANARY: proves the \`../../assets/...\` convention decks rely on actually
// resolves end to end through real marp-cli -- the stubbed test above proves the
// path arithmetic and symlink layout, but not that marp-cli itself, given
// --allow-local-files, follows that link out to a real file and embeds it. Skipped
// under the same gate as the checkLayout e2e canary above: marp-cli's own PDF
// export needs a real headless browser, pointed at via CHROME_PATH so it reuses the
// installed Chrome instead of trying to download one.
describe.skipIf(!E2E_AVAILABLE)("createHostRenderer.render e2e canary (real marp-cli, bundle asset resolution)", () => {
  it(
    "renders a real deck referencing ../../assets/logo.svg through real marp-cli, producing a nonzero-size PDF",
    async () => {
      const bundle = makeE2eBundleWithAssets();
      const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-e2e-scratch-"));
      const deckDir = makeDeckDir();
      writeFileSync(join(deckDir, "slides.md"), E2E_ASSET_SLIDES_MD);

      const renderer = createHostRenderer({
        bundleRef: createBundleRef(bundle),
        scratchRoot,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CHROME_PATH: E2E_CHROME_PATH },
      });

      const result = await renderer.render({ key: "e2e:asset-probe", deckDir, slug: "my-deck", pptx: false, timeoutMs: 100_000 });

      expect(result.code).toBe(0);
      const pdfPath = join(deckDir, "my-deck.pdf");
      expect(existsSync(pdfPath)).toBe(true);
      expect(statSync(pdfPath).size).toBeGreaterThan(0);
    },
    120_000,
  );
});

const E2E_TABLE_SLIDES_MD = `---
marp: true
theme: sample
---

# Deck with a table

| Material | Impact |
| --- | --- |
| Concrete | High |
| Timber | Low |
`;

// E2E CANARY: the only test in this file that runs the real pptx pipeline end to
// end -- real marp-cli, the real vendored gen-pptx.js (real puppeteer-core launching
// real headless Chrome to measure the DOM), and the real (never stubbed elsewhere)
// fixPptxTables port. Every other pptx test in this file stubs gen-pptx entirely, so
// none of them proves the vendored exporter and deckd's own table-fix port actually
// agree on the XML shape gen-pptx's real output has. Skipped under the same gate as
// the other e2e canaries above (needs a real Chrome + npx/marp-cli on PATH).
describe.skipIf(!E2E_AVAILABLE)("createHostRenderer.render e2e canary (real marp-cli + real gen-pptx + real table fix)", () => {
  it(
    "produces a nonzero pptx that unzips and contains the restyled table",
    async () => {
      const bundle = makeE2eBundle();
      const scratchRoot = mkdtempSync(join(tmpdir(), "deckd-e2e-scratch-"));
      const deckDir = makeDeckDir();
      writeFileSync(join(deckDir, "slides.md"), E2E_TABLE_SLIDES_MD);

      const renderer = createHostRenderer({
        bundleRef: createBundleRef(bundle),
        scratchRoot,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        chromePath: E2E_CHROME_PATH,
      });

      const started = Date.now();
      const result = await renderer.render({ key: "e2e:pptx-probe", deckDir, slug: "my-deck", pptx: true, timeoutMs: 100_000 });
      const elapsedMs = Date.now() - started;
      // eslint-disable-next-line no-console -- deliberate: the task asks this canary's runtime be reported.
      console.log(`e2e pptx canary: ${elapsedMs}ms`);

      expect(result.code).toBe(0);

      const pptxPath = join(deckDir, "my-deck-editable.pptx");
      expect(existsSync(pptxPath)).toBe(true);
      expect(statSync(pptxPath).size).toBeGreaterThan(0);

      const zip = await JSZip.loadAsync(readFileSync(pptxPath));
      const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      expect(slideNames.length).toBeGreaterThan(0);
      const slideXmls = await Promise.all(slideNames.map((n) => zip.file(n)?.async("string") ?? Promise.resolve("")));
      const tableSlide = slideXmls.find((xml) => xml.includes("<a:tbl>"));
      expect(tableSlide).toBeDefined();
      if (tableSlide === undefined) throw new Error("unreachable: asserted above");
      // fixPptxTables' corrective shape: no vertical borders, the 2pt Ink header
      // rule, and no cell left at the exporter's zero row height.
      expect(tableSlide).toContain('<a:lnL w="12700"><a:noFill/></a:lnL>');
      expect(tableSlide).toContain("1D1C30");
      expect(tableSlide).not.toContain('h="0"');
    },
    120_000,
  );
});
