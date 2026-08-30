#!/usr/bin/env node
// The deckd CLI: subcommands over the same engine code the server and MCP paths
// use (bundle.ts, host-render.ts, bundle-pack.ts) -- no rendering/validation logic
// is duplicated here, only argument parsing and console output. See README.md for
// the invocation story (this file has no build step of its own; it runs under tsx
// or the tsc-built dist/cli.js).
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadBundle, createBundleRef, type Bundle } from "./bundle.js";
import { createHostRenderer, formatLayoutReport } from "./host-render.js";
import { resolveChromePath } from "./config.js";
import { packBundle } from "./bundle-pack.js";
import { SLUG_RE } from "./artifacts.js";

// A CLI failure is a message to a human on stderr and a non-zero exit, never a raw
// stack trace -- every command's errors (bad args, a missing deckd.json, a Chrome/
// marp resolution failure, a render failure) funnel through this one path.
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

const USAGE = `Usage: deckd <command> [args]

Commands:
  render <deck-dir> [--pptx]     Render a deck to PDF (and optionally PPTX);
                                  outputs land next to the deck's slides.md.
  check <deck-dir>               Check a deck for slide-layout overflow.
  previews <deck-dir>            Render per-slide PNGs into <deck-dir>/preview/.
  pack [-o bundle.zip] [--theme P] [--assets P] [--examples P] [--guide P]
                                  Zip deckd.json plus its manifest-referenced
                                  paths. With no deckd.json in the current
                                  directory, --theme (required) and the other
                                  flags synthesize a manifest, written into the
                                  zip only -- never into the current directory.
  serve                          Start the deckd web/MCP server (same as
                                  \`npm run dev\`).

render/check/previews run against the bundle rooted at the current directory
(it must contain deckd.json). pack works with or without one.`;

// CLI-only scratch location: kept out of whatever repo the CLI is run inside (a
// bundle repo's own working tree must never gain untracked render-scratch churn),
// under a fixed (not random) name so successive invocations reuse the same
// symlinks/cache the way the server's own scratchRoot does (see host-render.ts's
// ensureSymlink).
const CLI_SCRATCH_ROOT = join(tmpdir(), "deckd-cli-scratch");

// Every render/check/previews command calls this before resolveDeckDir: a missing
// bundle is the more fundamental problem (nothing will render without one, no
// matter which deck was named), so it's what a user sees first rather than a
// deck-not-found error that would go away anyway once the bundle is fixed.
function loadCliBundle(cwd: string): Bundle {
  if (!existsSync(join(cwd, "deckd.json"))) {
    fail(
      `no deckd.json found in ${cwd} -- render/check/previews run inside a bundle repo ` +
        "(a directory with deckd.json at its root, or use `deckd pack` to build one). See README.",
    );
  }
  return loadBundle(cwd);
}

// deck-dir may be a path like "presentations/foo": the slug is its basename, and
// must still pass the same SLUG_RE every other deck-slug path in deckd enforces.
function resolveDeckDir(cwd: string, argPath: string | undefined): { deckDir: string; slug: string } {
  if (argPath === undefined) fail("a deck directory is required, e.g. `deckd render presentations/my-deck`");
  const deckDir = resolve(cwd, argPath);
  if (!existsSync(join(deckDir, "slides.md"))) fail(`no slides.md found in ${deckDir}`);
  const slug = basename(deckDir);
  if (!SLUG_RE.test(slug)) fail(`deck directory name "${slug}" is not a valid slug (must match ${SLUG_RE.source})`);
  return { deckDir, slug };
}

function parseFlags(args: string[], valueFlags: readonly string[]): { positional: string[]; flags: Map<string, string>; bool: Set<string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bool = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valueFlags.includes(name)) {
        const value = args[i + 1];
        if (value === undefined) fail(`--${name} requires a value`);
        flags.set(name, value);
        i++;
      } else {
        bool.add(name);
      }
    } else if (a === "-o") {
      const value = args[i + 1];
      if (value === undefined) fail("-o requires a value");
      flags.set("o", value);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, bool };
}

async function cmdRender(cwd: string, args: string[]): Promise<void> {
  const { positional, bool } = parseFlags(args, []);
  const pptx = bool.has("pptx");
  const bundle = loadCliBundle(cwd);
  const { deckDir, slug } = resolveDeckDir(cwd, positional[0]);
  // Only a pptx export needs Chrome (render() itself is pdf-only otherwise); a plain
  // `deckd render` on a machine with no Chrome installed must still work.
  const chromePath = pptx ? resolveChromePath(process.env) : undefined;
  const hostRenderer = createHostRenderer({
    bundleRef: createBundleRef(bundle), scratchRoot: CLI_SCRATCH_ROOT, env: process.env, chromePath,
  });
  const result = await hostRenderer.render({ key: `cli:${slug}`, deckDir, slug, pptx });
  if (result.output.trim() !== "") console.log(result.output.trim());
  if (result.code !== 0) fail(`render failed (exit ${result.code})`);
  console.log(`wrote ${join(deckDir, `${slug}.pdf`)}`);
  if (pptx) console.log(`wrote ${join(deckDir, `${slug}-editable.pptx`)}`);
}

async function cmdCheck(cwd: string, args: string[]): Promise<void> {
  const { positional } = parseFlags(args, []);
  const bundle = loadCliBundle(cwd);
  const { deckDir, slug } = resolveDeckDir(cwd, positional[0]);
  const chromePath = resolveChromePath(process.env);
  const hostRenderer = createHostRenderer({
    bundleRef: createBundleRef(bundle), scratchRoot: CLI_SCRATCH_ROOT, env: process.env, chromePath,
  });
  const result = await hostRenderer.checkLayout({ key: `cli:${slug}`, deckDir, slug });
  if (result.code !== 0) fail(`layout check failed (exit ${result.code}):\n${result.output}`);
  console.log(formatLayoutReport(result.issues));
  if (result.issues.length > 0) process.exitCode = 1;
}

async function cmdPreviews(cwd: string, args: string[]): Promise<void> {
  const { positional } = parseFlags(args, []);
  const bundle = loadCliBundle(cwd);
  const { deckDir, slug } = resolveDeckDir(cwd, positional[0]);
  // Previews never need Chrome (marp's own --images png output), so chromePath is
  // deliberately left unset here.
  const hostRenderer = createHostRenderer({ bundleRef: createBundleRef(bundle), scratchRoot: CLI_SCRATCH_ROOT, env: process.env });
  const result = await hostRenderer.renderPreviews({ key: `cli:${slug}`, deckDir, slug });
  if (result.code !== 0) fail(`preview render failed (exit ${result.code}):\n${result.output}`);
  console.log(`wrote ${result.pngs.length} preview PNG(s) to ${join(deckDir, "preview")}`);
}

async function cmdPack(cwd: string, args: string[]): Promise<void> {
  const { flags } = parseFlags(args, ["theme", "assets", "examples", "guide"]);
  const outPath = resolve(cwd, flags.get("o") ?? "bundle.zip");
  const result = await packBundle({
    cwd, outPath, theme: flags.get("theme"), assets: flags.get("assets"), examples: flags.get("examples"), guide: flags.get("guide"),
  });
  console.log(`wrote ${result.outPath} (${result.fileCount} file(s))`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "render":
      await cmdRender(cwd, rest);
      return;
    case "check":
      await cmdCheck(cwd, rest);
      return;
    case "previews":
      await cmdPreviews(cwd, rest);
      return;
    case "pack":
      await cmdPack(cwd, rest);
      return;
    case "serve":
      // Starts the exact same server index.ts's own module-level composition
      // builds -- no separate startup path to keep in sync with it.
      await import("./index.js");
      return;
    case undefined:
      console.error(USAGE);
      process.exitCode = 1;
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(USAGE);
      fail(`unknown command: ${command}`);
  }
}

main().catch((e: unknown) => {
  console.error(`deckd: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
