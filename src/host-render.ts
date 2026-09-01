import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  copyFileSync,
  rmSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLUG_RE, isExcludedDeckEntry } from "./artifacts.js";
import type { Bundle, BundleRef } from "./bundle.js";
import { fixPptxTables } from "./pptx-table-fix.js";

const require = createRequire(import.meta.url);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// This is now purely the pin's documentation/assertion: @marp-team/marp-cli is a
// package.json dependency pinned to this exact version (see the pinned-version
// consistency test in host-render.test.ts), and marp is invoked as the real
// installed binary (see resolveMarpBinPath) rather than via a version string passed
// to npx.
export const MARP_CLI_VERSION = "4.5.0";

// Resolves the marp binary shipped by the pinned @marp-team/marp-cli dependency via
// Node's own module resolution (require.resolve), rather than assuming a fixed
// node_modules/.bin/marp path at some fixed depth from this file: that keeps working
// whether host-render.ts runs from src/ (tsx, dev) or dist/ (built), and regardless
// of how the package manager laid out node_modules (hoisted or not). require.resolve
// on the package's own package.json -- rather than the package's main entry -- is
// what lets this read the package's own declared "bin" field instead of guessing a
// filename.
//
// Exported for tests: this is what an e2e canary should gate its "is the real
// toolchain available" check on, rather than an `npx` on PATH -- host-render.ts
// hasn't invoked npx since resolveMarpBinPath replaced it.
export function resolveMarpBinPath(): string {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve("@marp-team/marp-cli/package.json");
  } catch (e: unknown) {
    throw new Error(
      `@marp-team/marp-cli (pinned in package.json at ${MARP_CLI_VERSION}) is not installed; run npm install. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: string | Record<string, string> };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.marp;
  if (binRel === undefined) {
    throw new Error(`@marp-team/marp-cli's package.json has no "marp" bin entry (looked in ${pkgJsonPath})`);
  }
  return join(dirname(pkgJsonPath), binRel);
}

// Vendored (see vendor/marp-to-editable-pptx/README.md's provenance note). Resolved
// relative to this module's own file location -- not process.cwd() -- so it keeps
// working from src/ (dev) or dist/ (built), both of which sit one directory below the
// repo root that vendor/ lives in.
const VENDOR_GEN_PPTX_PATH = join(MODULE_DIR, "..", "vendor", "marp-to-editable-pptx", "src", "native-pptx", "tools", "gen-pptx.js");

export interface HostRenderResult {
  code: number;
  output: string;
}

export interface HostPreviewResult {
  code: number;
  output: string;
  pngs: string[];
}

// slide is 1-based, matching HostPreviewResult's pngs ordering (marp-cli's own
// 001-indexed page naming). kind names the axis that overflowed the fixed slide
// box: Marpit's section element clips both, so a slide can carry either or both.
export interface LayoutIssue {
  slide: number;
  kind: "overflow-y" | "overflow-x";
  amountPx: number;
}

// Renders a layout-check result as plain text, for either an AI (mcp.ts's
// check_deck) or a human (cli.ts's `deckd check`) to read directly, without having
// to parse the structured LayoutIssue[] itself. Shared here rather than duplicated
// in both callers.
export function formatLayoutReport(issues: LayoutIssue[]): string {
  if (issues.length === 0) return "No layout issues found: every slide fits inside the fixed slide box.";
  const lines = issues.map((i) => `slide ${i.slide}: ${i.kind} by ${i.amountPx}px`);
  return `${issues.length} layout issue(s) found (content clipped by the fixed slide box):\n${lines.join("\n")}`;
}

export interface HostCheckLayoutResult {
  code: number;
  output: string;
  issues: LayoutIssue[];
}

export interface HostRenderJob {
  key: string;
  deckDir: string;
  slug: string;
  pptx: boolean;
  timeoutMs?: number;
}

export interface HostPreviewJob {
  key: string;
  deckDir: string;
  slug: string;
  timeoutMs?: number;
}

export interface HostCheckLayoutJob {
  key: string;
  deckDir: string;
  slug: string;
  timeoutMs?: number;
}

// Runs one child process to completion. render(), renderPreviews() and
// checkLayout() (each spawning the vendored marp binary directly) go through this
// seam so tests can stub a single injectable point instead of needing real binaries
// or fixture scripts on PATH.
export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface HostRendererOptions {
  // Consulted per job (see prepareScratch), not captured once, so a bundle swapped
  // in mid-run via PUT /api/bundle is visible to the very next render/preview/check.
  bundleRef: BundleRef;
  scratchRoot: string;
  log?: (msg: string) => void;
  // The child process's environment (PATH, HOME, ...). deckd never reads process.env
  // inside library modules, so the composition root builds this and passes it in; a
  // bare PATH string is accepted as a shorthand when HOME etc. don't matter.
  env?: NodeJS.ProcessEnv;
  path?: string;
  exec?: SpawnFn;
  // Absolute path to a Chrome/Chromium binary, used by checkLayout and by a pptx
  // export's browser-measured gen-pptx step. Composition root resolves this (see
  // config.ts's resolveChromePath); a HostRenderer built without it can still
  // render() a plain pdf and renderPreviews() fine, and only checkLayout and a
  // render({pptx:true}) fail, clearly, the first time either is actually called.
  chromePath?: string;
  // Test-only override for the resolved marp binary path (see resolveMarpBinPath).
  // Production callers never set this -- it defaults to the real installed
  // @marp-team/marp-cli binary -- but a test can point it at a stub script so the
  // exec seam doesn't need real marp-cli/Chrome to exercise render()'s plumbing.
  marpBinPath?: string;
  // Test-only override for the vendored gen-pptx.js CLI path (see
  // VENDOR_GEN_PPTX_PATH). Production callers never set this.
  genPptxPath?: string;
}

export interface HostRenderer {
  render(job: HostRenderJob): Promise<HostRenderResult>;
  renderPreviews(job: HostPreviewJob): Promise<HostPreviewResult>;
  checkLayout(job: HostCheckLayoutJob): Promise<HostCheckLayoutResult>;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 8000;
const SCRATCH_KEY_RE = /[^a-zA-Z0-9_.-]/g;
// >2px is treated as slack rather than sub-pixel rounding noise from the browser's
// layout engine; anything at or under this is not reported as an issue.
const LAYOUT_OVERFLOW_TOLERANCE_PX = 2;
const LAYOUT_METRICS_MARKER_PREFIX = "deckd-layout-metrics";
// Chrome dump-dom stdout is kept to only its last CHROME_DUMP_MAX_BYTES bytes (see
// runChromeDump): the layout-metrics marker is always the very last thing appended to
// the DOM, so the tail always contains it, and the cap bounds how much an
// agent-authored deck's own embedded content (giant inline SVGs, base64 fonts/images)
// can blow up this buffer before that point.
const CHROME_DUMP_MAX_BYTES = 32 * 1024 * 1024;

// Exported for tests: sanitizing alone is lossy ("a:b" and "a_b" both sanitize to
// "a_b"), so distinct raw keys could otherwise collide on one scratch dir and race
// each other's render. Appending a short hash of the raw key keeps the prefix
// readable while guaranteeing distinct keys land in distinct directories.
export function sanitizeKey(key: string): string {
  const safe = key.replace(SCRATCH_KEY_RE, "_");
  const prefix = safe === "" ? "_" : safe;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `${prefix}-${hash}`;
}

// Creates or repairs a symlink at `dest` pointing at `target`, but only touches the
// filesystem when it isn't already correct — this is what lets the scratch dir be
// reused across renders (uv's venv and vendor's npm cache live under it).
function ensureSymlink(target: string, dest: string): void {
  let existing: Stats | null = null;
  try {
    existing = lstatSync(dest);
  } catch {
    existing = null;
  }
  if (existing !== null) {
    if (existing.isSymbolicLink() && resolve(readlinkSync(dest)) === target) return;
    // rmSync stats through a symlink, so on a dangling one (pointing at a path that no
    // longer exists) it finds nothing to remove and silently no-ops, leaving the stale
    // link in place; unlinkSync removes the link entry itself regardless of its target.
    if (existing.isSymbolicLink()) unlinkSync(dest);
    else rmSync(dest, { recursive: true, force: true });
  }
  symlinkSync(target, dest);
}

// Symlinks the bundle's theme into scratch as a fixed "theme.css" name (every
// --theme flag below points at this exact path, so the manifest's own theme
// filename doesn't matter), and, if the bundle carries one, its assets dir under a
// fixed "assets" name -- also independent of the manifest's own directory name.
// Deck markdown references bundle assets via a fixed relative path convention,
// `../../assets/...` from `presentations/<slug>/slides.md`; the scratch link name
// must stay pinned to that convention rather than following whatever directory
// name the manifest happens to declare (e.g. a bundle whose manifest says
// `"assets": "shared/presentations"` would otherwise link scratch/presentations to
// the bundle's own assets dir, and prepareScratch's mirror mkdirSync would then
// follow that link and write the deck mirror inside the bundle's assets directory;
// a manifest naming its assets dir "theme.css" would otherwise clobber the theme
// link above). Fixing the link name makes both collisions structurally impossible.
function ensureBundleLinks(bundle: Bundle, scratchDir: string): void {
  ensureSymlink(bundle.themeCss, join(scratchDir, "theme.css"));
  if (bundle.assetsDir !== undefined) {
    ensureSymlink(bundle.assetsDir, join(scratchDir, "assets"));
  }
}

// Mirrors deckDir's entries into mirrorDir as per-entry symlinks, except what
// isExcludedDeckEntry excludes (charts.py, __pycache__, any *.py file, preview/) and
// symlinks. This is the security boundary: charts.py is agent-authored and untrusted,
// so it must never execute on the host. Excluding it from the mirror is a structural
// guarantee that marp never sees it, rather than a check this module has to remember
// to make on every invocation. preview/ is
// renderPreviews' own output copied back into deckDir (see copyPreviewsBack); without
// this exclusion each preview run would mirror its own previous PNGs into the
// scratch dir alongside the deck, growing without bound across runs.
//
// Deck entries that are themselves symlinks are also skipped. Mirroring one would
// create a mirror symlink pointing at the deckDir entry's path, which the kernel
// still resolves through the original symlink — letting an attacker-created symlink
// read or write anywhere the host process can reach. A real deck has no symlinks, so
// this is a hard skip, not an attempt to judge which targets are "safe".
function syncDeckMirror(deckDir: string, mirrorDir: string, log: (msg: string) => void): void {
  mkdirSync(mirrorDir, { recursive: true });
  const wanted = new Set<string>();
  for (const entry of readdirSync(deckDir)) {
    if (isExcludedDeckEntry(entry)) continue;
    if (lstatSync(join(deckDir, entry)).isSymbolicLink()) {
      log(`host-render: skipping symlinked deck entry "${entry}" (deck entries must be regular files/dirs)`);
      continue;
    }
    wanted.add(entry);
  }

  for (const entry of readdirSync(mirrorDir)) {
    if (wanted.has(entry)) continue;
    let isStaleLink = false;
    try {
      isStaleLink = lstatSync(join(mirrorDir, entry)).isSymbolicLink();
    } catch {
      isStaleLink = false;
    }
    // Same dangling-symlink caveat as ensureSymlink: these targets are typically gone
    // (the deck entry they pointed at was removed), so unlinkSync, not rmSync, is what
    // actually clears the stale link.
    if (isStaleLink) unlinkSync(join(mirrorDir, entry));
  }

  for (const entry of wanted) {
    ensureSymlink(resolve(join(deckDir, entry)), join(mirrorDir, entry));
  }
}

// copyFileSync opens the destination path directly, so if deckDir already has a
// symlink at that name (attacker-created, pointing anywhere the host can write) the
// copy would write through it. Removing a pre-existing symlink first guarantees the
// copy always lands as a plain regular file in deckDir.
function copyFileReplacingSymlink(src: string, dest: string): void {
  if (!existsSync(src)) return;
  try {
    if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest);
  } catch {
    // dest doesn't exist yet: nothing to remove
  }
  copyFileSync(src, dest);
}

// Removes only the entries in dir that look like a previous run's rendered PNGs
// (matching previewPngRe). preview/ is documented as reserved for generated
// screenshots, but a deck that dropped an unrelated file there anyway keeps it: the
// stale-clear's job is to drop ghost slides from a deck that used to have more of
// them, not to wipe the directory. A matching symlink entry is unlinked rather than
// followed-and-removed (unlinkSync/rmSync both only ever remove the directory entry
// itself for a symlink, never its target), so an attacker-created symlink can't be abused to
// delete something outside dir.
function clearStalePreviewPngs(dir: string, slug: string): void {
  const re = previewPngRe(slug);
  for (const entry of readdirSync(dir)) {
    if (!re.test(entry)) continue;
    const p = join(dir, entry);
    if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
    else rmSync(p, { recursive: true, force: true });
  }
}

// mkdirSync({recursive:true}) does not throw when dir is a symlink pointing at an
// existing directory, and readdir/rm both follow it — so a pre-existing symlink at
// dir (e.g. an attacker-created deckDir/preview -> /anywhere) would turn every later
// operation against dir into writes against whatever it points to. lstat-and-unlink
// first, the same pattern ensureSymlink and copyFileReplacingSymlink use, guarantees
// dir is always a fresh real directory before anything is read from or written to it.
function ensureRealDir(dir: string): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
  } catch {
    // doesn't exist yet: nothing to remove
  }
  mkdirSync(dir, { recursive: true });
}

function copyBack(mirrorDir: string, deckDir: string, slug: string): void {
  copyFileReplacingSymlink(join(mirrorDir, `${slug}.pdf`), join(deckDir, `${slug}.pdf`));
}

function copyPptxBack(mirrorDir: string, deckDir: string, slug: string): void {
  copyFileReplacingSymlink(join(mirrorDir, `${slug}-editable.pptx`), join(deckDir, `${slug}-editable.pptx`));
}

// Matches marp-cli's --images png output naming, verified against real marp-cli
// 4.5.0 output: `<name>.NNN.png`, zero-padded to (at least) 3 digits, one file per
// slide, starting at 001 even for a single-slide deck. Parsing the numeric group
// (rather than sorting the filenames lexically) keeps ordering correct if a deck ever
// grows past 999 slides and marp widens the padding.
function previewPngRe(slug: string): RegExp {
  // slug is validated by SLUG_RE ([a-z0-9-]) before this is ever called, so it has no
  // regex metacharacters to escape.
  return new RegExp(`^${slug}\\.(\\d+)\\.png$`);
}

// Copies the PNGs marp wrote under `<mirrorDir>/preview/` back to `<deckDir>/preview/`,
// in slide order. destDir is first guaranteed to be a real directory (see
// ensureRealDir), then stale rendered PNGs already there are cleared so a deck that
// used to have more slides doesn't leave ghost images behind, and each copy replaces
// a pre-existing symlink at the destination the same way copyBack does for the
// pdf/pptx, so an attacker-created symlink can't redirect the write.
function copyPreviewsBack(mirrorDir: string, deckDir: string, slug: string): string[] {
  const srcDir = join(mirrorDir, "preview");
  const destDir = join(deckDir, "preview");
  ensureRealDir(destDir);
  clearStalePreviewPngs(destDir, slug);

  const re = previewPngRe(slug);
  const names = (existsSync(srcDir) ? readdirSync(srcDir) : [])
    .map((name) => ({ name, match: re.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((e) => e.name);

  const pngs: string[] = [];
  for (const name of names) {
    const dest = join(destDir, name);
    copyFileReplacingSymlink(join(srcDir, name), dest);
    pngs.push(dest);
  }
  return pngs;
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

// Matches the marker vendor/marp-to-editable-pptx/lib/native-pptx.cjs's
// generateNativePptx() prints right after puppeteer.launch() resolves (see that
// file's README for why: @puppeteer/browsers launches Chrome with `detached: true`
// on non-Windows with no supported way to override it through puppeteer-core's
// public launch() API, so Chrome always becomes the leader of its OWN process
// group -- one level detached from gen-pptx.js's group -- and killProcessGroup on
// gen-pptx's own pid can never reach it). Global so a late-arriving duplicate
// (there shouldn't be one) doesn't stop the scan; the last match wins, same
// last-one-wins convention as parseLayoutMetrics.
const CHROME_PID_MARKER_RE = /\[deckd\] chrome-pid: (\d+)/g;

function extractLastChromePid(text: string): number | undefined {
  const re = new RegExp(CHROME_PID_MARKER_RE);
  let m: RegExpExecArray | null;
  let last: number | undefined;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

// stdin is explicitly ignored: marp-cli detects a non-TTY stdin that isn't closed
// and blocks waiting for input ("Currently waiting data from stdin stream") instead
// of proceeding to render. Node's default stdio pipes stdin open with nothing
// writing to it, which reproduces the same hang, so every command run through this
// seam gets a closed stdin instead.
const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

// Runs one command to completion (or until it times out), capturing combined
// stdout+stderr capped to OUTPUT_LIMIT as it arrives, and killing the whole process
// group on timeout so a detached child (and anything it spawned, e.g. gen-pptx's own
// puppeteer-launched browser) doesn't outlive the promise.
function runProcess(
  exec: SpawnFn,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<HostRenderResult> {
  return new Promise((resolvePromise) => {
    let output = "";
    let settled = false;
    // Only ever set by gen-pptx's own invocation (see CHROME_PID_MARKER_RE); every
    // other command this runs (marp) never prints the marker, so this stays
    // undefined and the extra kill below is simply skipped for them.
    let chromePid: number | undefined;

    const child = exec(command, args, { cwd, env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessGroup(child.pid);
      // gen-pptx's browser is detached into its own process group (see
      // extractLastChromePid's doc comment), so killing gen-pptx's own group above
      // never reaches it -- it needs its own, separate kill.
      if (chromePid !== undefined) killProcessGroup(chromePid);
      output += `\n[deckd] render timeout after ${timeoutMs}ms`;
      resolvePromise({ code: -1, output: output.slice(-OUTPUT_LIMIT) });
    }, timeoutMs);

    // Capped as each chunk arrives, not just at the end: a long-running render can
    // otherwise grow `output` to the size of its entire stdout/stderr before settling.
    const appendOutput = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_LIMIT);
      const pid = extractLastChromePid(output);
      if (pid !== undefined) chromePid = pid;
    };
    child.stdout?.on("data", (d: Buffer) => appendOutput(d.toString()));
    child.stderr?.on("data", (d: Buffer) => appendOutput(d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: -1, output: `${output}\n${String(err)}`.slice(-OUTPUT_LIMIT) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output: output.slice(-OUTPUT_LIMIT) });
    });
  });
}

// Exported for tests: the exact marker element id checkLayout's injected script writes
// into the DOM, and the id parseLayoutMetrics's regex extracts back out. Always built
// from a caller-supplied nonce (checkLayout generates a fresh crypto.randomUUID() per
// call) rather than a fixed string -- deck markdown can contain raw HTML (marp --html),
// including a forged `<div id="deckd-layout-metrics">...</div>`, and a fixed marker id
// would let that forged element be extracted as if it were the real measurement. A
// nonce the deck cannot know defeats that: it can forge the old static id, but not this
// run's id, and a UUID's fixed hex/hyphen alphabet needs no regex escaping.
export function layoutMetricsMarkerId(nonce: string): string {
  return `${LAYOUT_METRICS_MARKER_PREFIX}-${nonce}`;
}

// Appended to the marp-rendered check HTML before it's loaded in Chrome. Runs as
// the last thing on the page (see injectLayoutMetricsScript), so by the time it
// executes the whole slide DOM is already parsed; reading scrollHeight/scrollWidth
// forces the layout Chrome would otherwise defer. The result is written into a
// dedicated element (rather than e.g. console.log) because --dump-dom is the only
// piece of plain `chrome --headless` that reports back to the host process without
// depending on puppeteer or Chrome's remote-debugging protocol.
//
// Scoped to `foreignObject > section`, not a bare `section` selector: verified against
// real marp-cli --html output (marp-cli@latest, 2026-08), each slide is
// `<svg data-marpit-svg><foreignObject><section id="N" lang="...">...</section></foreignObject></svg>`,
// with all the svgs siblings under one wrapper div -- there is no `.marpit` wrapper
// class in this (non--images) output mode. A `<section>` a deck injects via raw HTML
// inside its own slide content nests inside that real section, as a descendant of the
// section rather than a direct child of a foreignObject, so this selector counts only
// the true one-per-slide top-level sections and never shifts subsequent slide numbers.
function layoutMetricsScript(nonce: string): string {
  return `<script>
(function () {
  var sections = document.querySelectorAll("foreignObject > section");
  var results = [];
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    results.push({ slide: i + 1, overflowY: s.scrollHeight - s.clientHeight, overflowX: s.scrollWidth - s.clientWidth });
  }
  var marker = document.createElement("div");
  marker.id = ${JSON.stringify(layoutMetricsMarkerId(nonce))};
  marker.textContent = JSON.stringify(results);
  document.body.appendChild(marker);
})();
</script>`;
}

// Inserts layoutMetricsScript(nonce) right before the closing </body> tag so it runs
// after every section is in the DOM. Falls back to simply appending it if a marp
// output ever lacked a </body> (shouldn't happen for marp-cli's own output, but a
// missing insertion point should degrade to "script never runs", not throw).
function injectLayoutMetricsScript(htmlPath: string, nonce: string): void {
  const html = readFileSync(htmlPath, "utf8");
  const idx = html.lastIndexOf("</body>");
  const script = layoutMetricsScript(nonce);
  const patched = idx === -1 ? `${html}${script}` : `${html.slice(0, idx)}${script}${html.slice(idx)}`;
  writeFileSync(htmlPath, patched);
}

// Global so every occurrence of this call's nonce-scoped marker in the dump is found;
// parseLayoutMetrics below takes the last one. A deck's raw HTML cannot reproduce this
// id (see layoutMetricsMarkerId), so in practice at most one should ever appear -- the
// last-match choice is belt-and-braces on top of the nonce, not a substitute for it.
function layoutMetricsRe(nonce: string): RegExp {
  return new RegExp(`<div id="${layoutMetricsMarkerId(nonce)}">([^<]*)</div>`, "g");
}

// Pulls this call's metrics marker back out of Chrome's --dump-dom stdout and turns it
// into LayoutIssue[]. dumpedDom is untrusted in two ways: a stub/misbehaving Chrome
// could omit or malform the marker, and deck markdown (marp --html) can inject its own
// `<div id="...">...</div>` content -- the nonce in the regex is what keeps this call
// from ever matching anything the deck wrote instead of what this call's own injected
// script wrote.
export function parseLayoutMetrics(dumpedDom: string, nonce: string): LayoutIssue[] {
  const re = layoutMetricsRe(nonce);
  let m: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((m = re.exec(dumpedDom)) !== null) {
    lastMatch = m;
  }
  if (lastMatch === null) throw new Error("chrome dump-dom output did not contain the layout-metrics marker");

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch[1] ?? "[]");
  } catch {
    throw new Error("layout metrics marker unparseable");
  }
  if (!Array.isArray(parsed)) throw new Error("layout-metrics marker did not contain a JSON array");
  // A real deck always has at least one top-level slide section; zero here means
  // the `foreignObject > section` selector stopped matching marp's actual output
  // (e.g. a marp-cli DOM-structure change), not that the deck legitimately has no
  // slides. Silently returning [] in that case would read as "no layout issues"
  // instead of "the check didn't measure anything".
  if (parsed.length === 0) {
    throw new Error("chrome dump-dom output reported zero slide sections (marp DOM structure may have changed)");
  }

  const issues: LayoutIssue[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const slide = typeof e.slide === "number" ? e.slide : null;
    const overflowY = typeof e.overflowY === "number" ? e.overflowY : null;
    const overflowX = typeof e.overflowX === "number" ? e.overflowX : null;
    if (slide === null || overflowY === null || overflowX === null) continue;
    if (overflowY > LAYOUT_OVERFLOW_TOLERANCE_PX) issues.push({ slide, kind: "overflow-y", amountPx: overflowY });
    if (overflowX > LAYOUT_OVERFLOW_TOLERANCE_PX) issues.push({ slide, kind: "overflow-x", amountPx: overflowX });
  }
  return issues;
}

// Runs Chrome's --dump-dom to completion, the same timeout/kill-process-group
// contract as runProcess, but keeps stdout separate from stderr: marp's theme embeds
// fonts as base64, so a dumped deck can run past OUTPUT_LIMIT long before reaching the
// metrics marker appended at the very end of the document, and headless Chrome's own
// stderr chatter (macOS logs benign CVDisplayLink errors on every run) must not be able
// to crowd it out of a shared capped buffer the way runProcess's combined capture
// would. stdout is instead kept to its own much larger bound, CHROME_DUMP_MAX_BYTES
// (see its definition) -- large enough for a normal deck's fonts, but still bounded
// against an agent-authored deck's embedded content, rather than left to grow without
// limit for the lifetime of the dump. `output` (stderr, capped at OUTPUT_LIMIT) is only
// for surfacing a failure to a caller, never parsed.
function runChromeDump(
  exec: SpawnFn,
  chromePath: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; output: string }> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let errOutput = "";
    let settled = false;

    const child = exec(chromePath, args, { cwd, env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessGroup(child.pid);
      errOutput = `${errOutput}\n[deckd] layout check timeout after ${timeoutMs}ms`.slice(-OUTPUT_LIMIT);
      resolvePromise({ code: -1, stdout: "", output: errOutput });
    }, timeoutMs);

    // Bounded tail, applied as each chunk arrives so memory use never exceeds one
    // chunk beyond the cap: the marker is appended at the very end of body, so the
    // tail always contains it once the whole dump has arrived.
    child.stdout?.on("data", (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(-CHROME_DUMP_MAX_BYTES);
    });
    child.stderr?.on("data", (d: Buffer) => {
      errOutput = (errOutput + d.toString()).slice(-OUTPUT_LIMIT);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout: "", output: `${errOutput}\n${String(err)}`.slice(-OUTPUT_LIMIT) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, output: errOutput });
    });
  });
}

export function createHostRenderer(opts: HostRendererOptions): HostRenderer {
  const { bundleRef, scratchRoot } = opts;
  const log = opts.log ?? (() => {});
  const exec = opts.exec ?? defaultSpawn;
  const chromePath = opts.chromePath;
  const marpBinPath = opts.marpBinPath ?? resolveMarpBinPath();
  const genPptxPath = opts.genPptxPath ?? VENDOR_GEN_PPTX_PATH;
  // Neither `env` nor `path` given means the child runs with an empty environment,
  // which fails obscurely once marp tries to resolve its own dependencies. That's
  // only acceptable for tests driving a stubbed marp binary; a caller wiring up a
  // real render must supply one of the two.
  const childEnv: NodeJS.ProcessEnv = opts.env ?? (opts.path !== undefined ? { PATH: opts.path } : {});

  // Shared by render(), renderPreviews() and checkLayout(): validates the slug,
  // materializes the scratch dir with the bundle's theme (and assets, if any)
  // symlinked in, and syncs the deck mirror. Every caller needs the exact same
  // scratch/mirror setup and the exact same security invariants (no *.py, no
  // symlinks) — duplicating this would risk the paths drifting apart on those
  // invariants.
  function prepareScratch(key: string, deckDir: string, slug: string): { scratchDir: string; mirrorDir: string } {
    const scratchDir = join(scratchRoot, sanitizeKey(key));
    mkdirSync(scratchDir, { recursive: true });
    ensureBundleLinks(bundleRef.current(), scratchDir);

    const mirrorDir = join(scratchDir, "presentations", slug);
    syncDeckMirror(deckDir, mirrorDir, log);
    return { scratchDir, mirrorDir };
  }

  // Runs the pptx sub-pipeline after render()'s pdf step has already succeeded:
  // marp renders a second, throwaway HTML file beside slides.md (same directory the
  // pdf/pptx outputs use, so relative image paths resolve exactly as they do for the
  // pdf), gen-pptx.js (vendored, browser-measured via puppeteer-core) turns that HTML
  // into a native-editable pptx, the TS port of fix_pptx_tables.py restyles any
  // table in place, the transient HTML is removed from the mirror, and the pptx is
  // copied back into deckDir. Reuses the exact scratchDir/mirrorDir/deckRel render()
  // already set up, rather than re-syncing the mirror a second time.
  async function renderPptxArtifact(
    job: HostRenderJob,
    scratchDir: string,
    mirrorDir: string,
    deckRel: string,
    deadlineAt: number,
  ): Promise<HostRenderResult> {
    if (chromePath === undefined || chromePath === "") {
      return { code: -1, output: "no chromePath configured for pptx export (browser-measured)" };
    }

    const htmlName = `${job.slug}.html`;
    const htmlAbsPath = join(mirrorDir, htmlName);
    const pptxAbsPath = join(mirrorDir, `${job.slug}-editable.pptx`);

    const marpArgs = [
      "--theme",
      "theme.css",
      "--html",
      "--allow-local-files",
      `${deckRel}/slides.md`,
      "-o",
      `${deckRel}/${htmlName}`,
    ];
    const marpResult = await runProcess(exec, marpBinPath, marpArgs, scratchDir, childEnv, Math.max(1, deadlineAt - Date.now()));
    if (marpResult.code !== 0) return marpResult;

    // browserPath is passed explicitly as gen-pptx.js's 3rd CLI argument (the same
    // Chrome checkLayout already uses) rather than left to its own CHROME_PATH-env-var
    // or @puppeteer/browsers auto-detection fallback, so a pptx export never resolves
    // a different browser than the rest of deckd does.
    const genPptxResult = await runProcess(
      exec,
      "node",
      [genPptxPath, htmlAbsPath, pptxAbsPath, chromePath],
      scratchDir,
      childEnv,
      Math.max(1, deadlineAt - Date.now()),
    );
    if (genPptxResult.code !== 0) {
      return { code: genPptxResult.code, output: `${marpResult.output}\n${genPptxResult.output}`.slice(-OUTPUT_LIMIT) };
    }

    let fixOutput: string;
    try {
      const { tablesFixed, orphanedContentTypeOverridesRemoved } = await fixPptxTables(pptxAbsPath, deadlineAt);
      fixOutput = `restyled ${tablesFixed} table(s), pruned ${orphanedContentTypeOverridesRemoved} orphaned content-type override(s)`;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { code: -1, output: `${marpResult.output}\n${genPptxResult.output}\ntable fix failed: ${message}`.slice(-OUTPUT_LIMIT) };
    }

    // The HTML is a transient pipeline artifact, never deck content: it must not
    // linger in the mirror (syncDeckMirror's cleanup only sweeps stale symlinks, not
    // regular files marp itself wrote) and must never reach deckDir.
    rmSync(htmlAbsPath, { force: true });
    copyPptxBack(mirrorDir, job.deckDir, job.slug);

    return { code: 0, output: `${marpResult.output}\n${genPptxResult.output}\n${fixOutput}`.slice(-OUTPUT_LIMIT) };
  }

  async function render(job: HostRenderJob): Promise<HostRenderResult> {
    try {
      if (!SLUG_RE.test(job.slug)) return { code: -1, output: `bad slug: ${job.slug}` };

      const { scratchDir, mirrorDir } = prepareScratch(job.key, job.deckDir, job.slug);

      const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadlineAt = Date.now() + timeoutMs;
      log(`host-render ${job.key}: presentations/${job.slug} in ${scratchDir}`);
      const deckRel = `presentations/${job.slug}`;
      const renderConfig = bundleRef.current().render;
      const marpArgs = [
        "--theme",
        "theme.css",
        "--html",
        "--allow-local-files",
        ...(renderConfig.pdfOutlines ? ["--pdf-outlines"] : []),
        ...(renderConfig.pdfNotes ? ["--pdf-notes"] : []),
        `${deckRel}/slides.md`,
        "-o",
        `${deckRel}/${job.slug}.pdf`,
      ];
      const result = await runProcess(exec, marpBinPath, marpArgs, scratchDir, childEnv, Math.max(1, deadlineAt - Date.now()));
      if (result.code !== 0) {
        log(`host-render ${job.key}: exit ${result.code}`);
        return result;
      }
      copyBack(mirrorDir, job.deckDir, job.slug);

      if (!job.pptx) {
        log(`host-render ${job.key}: exit 0`);
        return result;
      }

      const pptxResult = await renderPptxArtifact(job, scratchDir, mirrorDir, deckRel, deadlineAt);
      const combinedOutput = `${result.output}\n${pptxResult.output}`.slice(-OUTPUT_LIMIT);
      log(`host-render ${job.key}: exit ${pptxResult.code} (pptx)`);
      return { code: pptxResult.code, output: combinedOutput };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log(`host-render ${job.key}: threw ${message}`);
      return { code: -1, output: message };
    }
  }

  async function renderPreviews(job: HostPreviewJob): Promise<HostPreviewResult> {
    try {
      if (!SLUG_RE.test(job.slug)) return { code: -1, output: `bad slug: ${job.slug}`, pngs: [] };

      const { scratchDir, mirrorDir } = prepareScratch(job.key, job.deckDir, job.slug);

      const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      log(`host-render-preview ${job.key}: presentations/${job.slug} in ${scratchDir}`);

      const deckRel = `presentations/${job.slug}`;
      const marpArgs = [
        "--theme",
        "theme.css",
        "--html",
        "--allow-local-files",
        "--images",
        "png",
        "--image-scale",
        String(bundleRef.current().render.imageScale),
        `${deckRel}/slides.md`,
        "-o",
        `${deckRel}/preview/${job.slug}.png`,
      ];
      const marpResult = await runProcess(exec, marpBinPath, marpArgs, scratchDir, childEnv, timeoutMs);

      if (marpResult.code !== 0) {
        log(`host-render-preview ${job.key}: exit ${marpResult.code}`);
        return { code: marpResult.code, output: marpResult.output, pngs: [] };
      }

      const pngs = copyPreviewsBack(mirrorDir, job.deckDir, job.slug);
      log(`host-render-preview ${job.key}: exit 0, ${pngs.length} png(s)`);
      return { code: 0, output: marpResult.output, pngs };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log(`host-render-preview ${job.key}: threw ${message}`);
      return { code: -1, output: message, pngs: [] };
    }
  }

  // Renders the deck to a throwaway HTML file (marp's --html, no --images: one
  // document with one <section> per slide, not per-slide PNGs) under the same
  // preview/ subdirectory renderPreviews uses, measures each section's clipped
  // overflow in headless Chrome, then deletes the HTML -- it's a transient check
  // artifact, never deck content, so it must never reach deckDir the way a real
  // preview's PNGs or a render's PDF do.
  async function checkLayout(job: HostCheckLayoutJob): Promise<HostCheckLayoutResult> {
    let checkHtmlPath: string | null = null;
    try {
      if (!SLUG_RE.test(job.slug)) return { code: -1, output: `bad slug: ${job.slug}`, issues: [] };
      if (chromePath === undefined || chromePath === "") {
        return { code: -1, output: "no chromePath configured for layout checks", issues: [] };
      }

      const { scratchDir, mirrorDir } = prepareScratch(job.key, job.deckDir, job.slug);
      const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadlineAt = Date.now() + timeoutMs;
      log(`host-render-checklayout ${job.key}: presentations/${job.slug} in ${scratchDir}`);

      const deckRel = `presentations/${job.slug}`;
      const checkHtmlName = `${job.slug}-check.html`;
      checkHtmlPath = join(mirrorDir, "preview", checkHtmlName);
      const marpArgs = [
        "--theme",
        "theme.css",
        "--html",
        "--allow-local-files",
        `${deckRel}/slides.md`,
        "-o",
        `${deckRel}/preview/${checkHtmlName}`,
      ];
      const marpResult = await runProcess(exec, marpBinPath, marpArgs, scratchDir, childEnv, Math.max(1, deadlineAt - Date.now()));
      if (marpResult.code !== 0) {
        log(`host-render-checklayout ${job.key}: marp exit ${marpResult.code}`);
        return { code: marpResult.code, output: marpResult.output, issues: [] };
      }

      // Fresh per call: this is what keeps a forged marker in deck content (marp
      // --html lets a deck emit arbitrary raw HTML) from ever being extracted as the
      // real measurement -- the deck has no way to learn this run's nonce.
      const nonce = randomUUID();
      injectLayoutMetricsScript(checkHtmlPath, nonce);

      const chromeArgs = [
        "--headless=new",
        "--disable-gpu",
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=5000",
        "--dump-dom",
        `file://${checkHtmlPath}`,
      ];
      const chromeResult = await runChromeDump(exec, chromePath, chromeArgs, scratchDir, childEnv, Math.max(1, deadlineAt - Date.now()));
      if (chromeResult.code !== 0) {
        log(`host-render-checklayout ${job.key}: chrome exit ${chromeResult.code}`);
        return { code: chromeResult.code, output: `${marpResult.output}\n${chromeResult.output}`.slice(-OUTPUT_LIMIT), issues: [] };
      }

      const issues = parseLayoutMetrics(chromeResult.stdout, nonce);
      log(`host-render-checklayout ${job.key}: exit 0, ${issues.length} issue(s)`);
      return { code: 0, output: marpResult.output, issues };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log(`host-render-checklayout ${job.key}: threw ${message}`);
      return { code: -1, output: message, issues: [] };
    } finally {
      // Always cleaned up, success or failure: the check HTML must never linger in
      // the mirror (it would otherwise get mirrored again next render, since the
      // mirror's exclusion rules only cover deckDir's own preview/, not the
      // scratch-side one this writes into) or leak into deckDir the way
      // copyPreviewsBack's PNGs deliberately do.
      if (checkHtmlPath !== null) rmSync(checkHtmlPath, { force: true });
    }
  }

  return { render, renderPreviews, checkLayout };
}
