import {
  readdirSync, lstatSync, rmSync, statSync, writeFileSync, readFileSync, renameSync, existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, extname, relative, sep } from "node:path";
import type { Config } from "./config.js";
import { loadBundle, readBundleManifest, type Bundle, type BundleRef, type BundleWriter, type Manifest } from "./bundle.js";
import {
  extractZip, stripSymlinks, stripOsJunk, listExampleDecks, copyDirSkippingSymlinks, resolveZipRoot,
} from "./artifacts.js";

// Matches the raw-body limit on PUT /api/bundle (server.ts): the compressed zip
// itself is bounded there, this bounds what it decodes to -- a small, highly
// compressible zip could otherwise decode to far more than its own upload size
// (a zip bomb), so this is a separate check, not a restatement of the same limit.
export const MAX_BUNDLE_TOTAL_BYTES = 100 * 1024 * 1024;
// Generous for a single font or image while still bounding any one file, independent
// of the total cap -- a bundle with many files just under the total cap but one huge
// outlier is still rejected clearly, naming that file, rather than only failing the
// aggregate check.
export const MAX_BUNDLE_FILE_BYTES = 20 * 1024 * 1024;

// Every file an uploaded bundle may carry is passive content something else reads
// (marp, a browser, an editor) -- never anything that executes. This is the complete
// allowlist; anything else (py, sh, js, cjs, mjs, html, or no extension at all --
// exactly how a shebang-less executable would be smuggled in) is rejected.
export const BUNDLE_CONTENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "css", "md", "markdown", "json", "svg", "png", "jpg", "jpeg", "webp", "gif",
  "woff", "woff2", "ttf", "otf", "txt",
]);

export interface BundleSummary {
  manifest: Manifest;
  fileCount: number;
  exampleCount: number;
  uploadedAt: number;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const st = lstatSync(join(dir, entry));
    n += st.isDirectory() ? countFiles(join(dir, entry)) : 1;
  }
  return n;
}

// Current bundle summary for GET /api/bundle, and PUT /api/bundle's own response
// after a successful swap. uploadedAt comes from the sibling marker file markUploaded
// maintains (see below) rather than tracked as separate in-memory state, so it
// survives a deckd restart; a bundle installed before that marker existed (a
// hand-seeded dev bundle, or one predating this file) falls back to deckd.json's own
// mtime so it still reports a sensible value.
export function bundleSummary(bundle: Bundle): BundleSummary {
  return {
    manifest: readBundleManifest(bundle.dir),
    fileCount: countFiles(bundle.dir),
    exampleCount: bundle.examplesDir === undefined ? 0 : listExampleDecks(bundle.examplesDir).length,
    uploadedAt: readUploadedAt(bundle.dir),
  };
}

// Walks an already symlink-stripped extraction tree and enforces the content
// allowlist plus the per-file/total size caps, before the bundle is ever considered
// for loadBundle or the live swap. Throws on the first violation, naming the exact
// offending file (relative to root) so a rejected upload is actionable.
function validateBundleContents(root: string): void {
  let total = 0;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        // stripSymlinks (called before this) removes every symlink in the tree; a
        // survivor here means it missed one, which must fail loudly rather than be
        // silently treated as a regular file.
        throw new Error(`bundle contains a symlink, which is not allowed: ${relative(root, p)}`);
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(root, p);
      const ext = extname(entry).slice(1).toLowerCase();
      if (!BUNDLE_CONTENT_EXTENSIONS.has(ext)) {
        throw new Error(
          `bundle contains a disallowed file: ${rel} (extension "${ext === "" ? "<none>" : `.${ext}`}" is not on the content allowlist)`,
        );
      }
      if (st.size > MAX_BUNDLE_FILE_BYTES) {
        throw new Error(`bundle file too large: ${rel} is ${st.size} bytes (max ${MAX_BUNDLE_FILE_BYTES} per file)`);
      }
      total += st.size;
      if (total > MAX_BUNDLE_TOTAL_BYTES) {
        throw new Error(`bundle exceeds the total decoded size cap of ${MAX_BUNDLE_TOTAL_BYTES} bytes`);
      }
    }
  }
  walk(root);
}

// Rename-swap into the live bundleDir: rename the old bundle aside, rename the new
// one in, delete the old one only once the new one is safely in place; a failure in
// the second rename restores the first, so bundleDir is never left empty or
// half-written. incomingDir must already sit on the same filesystem as bundleDir
// (see installBundleZip) so both renames are atomic directory-entry swaps, not a
// cross-device copy.
//
// A render already in flight when this runs keeps using whatever bundle its scratch
// dir's theme.css/assets symlinks pointed at when it started (see host-render.ts's
// prepareScratch/ensureSymlink): those symlinks store bundleDir's fixed absolute
// path, so the only race is the narrow window between the two renameSync calls
// below, during which that path briefly doesn't exist. Worst case, an in-flight
// render reads a dangling symlink and fails with ENOENT -- indistinguishable from
// any other transient render failure, and retryable the same way. This is
// deliberately not serialized through the render queue: quiescing every in-flight
// render for the length of a bundle upload would stall active decks for a race this
// narrow and this cheap to recover from.
//
// This function's body is entirely synchronous fs calls with no await point, so
// Node's run-to-completion guarantee -- not an explicit lock -- is what keeps two
// concurrent PUT /api/bundle requests from interleaving their renames. Adding an
// await anywhere in this body would reopen a window for a second call to run
// between the two renames and corrupt bundleDir, so keep the whole function
// synchronous.
export function swapBundleDir(bundleDir: string, incomingDir: string): Bundle {
  const staleDir = `${bundleDir}.stale-${randomUUID()}`;
  const hadExisting = existsSync(bundleDir);
  if (hadExisting) renameSync(bundleDir, staleDir);
  try {
    renameSync(incomingDir, bundleDir);
  } catch (e: unknown) {
    if (hadExisting) renameSync(staleDir, bundleDir);
    throw e;
  }
  if (hadExisting) rmSync(staleDir, { recursive: true, force: true });
  return loadBundle(bundleDir);
}

// A sibling of bundleDir -- not inside it, so it needs no special-casing in the
// content allowlist, size validation, stripOsJunk, or any zip production path -- that
// holds the epoch-ms timestamp of the last successful install/edit. Deliberately kept
// out of deckd.json's own mtime: applyBundleEdit's write of an unrelated file (e.g.
// write_bundle_file("theme.css")) must never appear to touch deckd.json, or a
// client's base_mtime for a LATER write to deckd.json itself would hit a false
// "modified on disk" conflict it never caused. The path is derived from bundleDir
// alone, so it survives swapBundleDir's rename (bundleDir's own path never changes,
// only what's inside it).
function uploadedAtMarkerPath(bundleDir: string): string {
  return `${bundleDir}.uploaded-at`;
}

// Writes "now" to the marker above, right after a successful swap, so bundleSummary's
// uploadedAt reflects when deckd installed or last edited the bundle -- not whatever
// timestamp a zip's own entries happened to carry (unzip preserves a zip's stored
// mtimes by default) and not deckd.json's own mtime (see uploadedAtMarkerPath above).
function markUploaded(bundleDir: string): void {
  writeFileSync(uploadedAtMarkerPath(bundleDir), String(Date.now()));
}

function readUploadedAt(bundleDir: string): number {
  try {
    const n = Number(readFileSync(uploadedAtMarkerPath(bundleDir), "utf8"));
    if (Number.isFinite(n)) return n;
  } catch {
    // No marker yet (a bundle installed before it existed); fall through.
  }
  return statSync(join(bundleDir, "deckd.json")).mtimeMs;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

// applyBundleEdit's validation runs against stagingDir, an internal temp path the
// caller never sees, so a thrown error naming an absolute path under it (e.g.
// bundle.ts's "bundle \"theme\" file not found: <stagingDir>/does-not-exist.css")
// would otherwise leak that implementation detail. Rewrites any occurrence of
// stagingDir in the message back to the bundle-relative path it corresponds to.
function relativizeStagingPath(e: unknown, stagingDir: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  const rewritten = message.split(`${stagingDir}${sep}`).join("").split(stagingDir).join(".");
  return new Error(rewritten);
}

export interface BundleUploadOutcome {
  bundle: Bundle;
  summary: BundleSummary;
}

// The full PUT /api/bundle pipeline: extract, validate, then swap into cfg.bundleDir
// and update bundleRef so every module downstream (server/mcp/host-render) sees the
// new bundle on its very next operation, with no restart. Every validation step runs
// against incomingDir before anything touches the live bundleDir; a failure at any
// point before the final swap leaves the current bundle completely untouched.
export async function installBundleZip(
  zipBytes: Buffer,
  cfg: Config,
  bundleRef: BundleRef & BundleWriter,
  log: (msg: string) => void = () => {},
): Promise<BundleUploadOutcome> {
  // incomingDir is a sibling of bundleDir (same parent directory), not under
  // os.tmpdir(): swapBundleDir's rename must land on the same filesystem as
  // bundleDir, or it fails with EXDEV instead of the atomic directory-entry swap
  // it's meant to be.
  const incomingDir = join(dirname(cfg.bundleDir), `bundle.incoming-${randomUUID()}`);
  try {
    // extractZip validates every entry (rejecting zip-slip, backslashes, and
    // absolute paths the same way assertSafeZip/`unzip -Z1` used to) before
    // incomingDir is created at all, so a rejected zip never touches disk. The size
    // caps are enforced here too, as bytes stream off the decompressor, not only by
    // validateBundleContents below against what already landed on disk.
    await extractZip(zipBytes, incomingDir, log, { maxFileBytes: MAX_BUNDLE_FILE_BYTES, maxTotalBytes: MAX_BUNDLE_TOTAL_BYTES });
    stripSymlinks(incomingDir, log);
    // Before the content allowlist: a zip built by macOS Finder or Windows Explorer
    // routinely carries __MACOSX/._*, .DS_Store, Thumbs.db etc. the user never
    // intentionally added, and the allowlist would otherwise reject the whole upload
    // for it. This is the single strip point for both PUT /api/bundle and MCP's
    // upload_bundle -- both call installBundleZip.
    stripOsJunk(incomingDir, log);
    // After junk is gone: a zip built by zipping a FOLDER (not its contents --
    // Finder's default) wraps everything in one extra directory, so deckd.json ends
    // up at <incomingDir>/<wrapper>/deckd.json instead of the root. resolveZipRoot
    // applies the identical single-wrapper convention seedDeck's deck-import zips
    // already use (see artifacts.ts); it never guesses past exactly one candidate,
    // so two top-level directories with no root manifest still errors below.
    const bundleRoot = resolveZipRoot(incomingDir, "deckd.json");
    if (bundleRoot === null) {
      throw new Error(
        "bundle manifest not found: deckd.json (must be at the zip root, or inside a single wrapper " +
          "folder -- e.g. zipping a folder in Finder often wraps its contents in one extra directory)",
      );
    }
    if (bundleRoot !== incomingDir) {
      // Promote the wrapper directory's contents up to incomingDir itself: every
      // step below (validateBundleContents, loadBundle, swapBundleDir) operates on
      // incomingDir as the bundle root, so the wrapper layer must not survive past
      // this point.
      const flattenedDir = `${incomingDir}.flattened-${randomUUID()}`;
      renameSync(bundleRoot, flattenedDir);
      rmSync(incomingDir, { recursive: true, force: true });
      renameSync(flattenedDir, incomingDir);
    }
    validateBundleContents(incomingDir);
    // Validates deckd.json is present and well-formed, theme resolves, and nothing
    // escapes incomingDir -- the canonical "is this a valid bundle" check (spec
    // decision 3), run against the extracted tree before the live bundle is touched.
    loadBundle(incomingDir);

    const finalBundle = swapBundleDir(cfg.bundleDir, incomingDir);
    markUploaded(finalBundle.dir);
    bundleRef.replace(finalBundle);
    return { bundle: finalBundle, summary: bundleSummary(finalBundle) };
  } catch (e: unknown) {
    throw relativizeStagingPath(e, incomingDir);
  } finally {
    // A no-op once swapBundleDir has moved incomingDir into place; only actually
    // cleans up when a validation step above threw first.
    rmSync(incomingDir, { recursive: true, force: true });
  }
}

// Shared stage-validate-swap path for any bundle mutation that isn't a full-zip
// upload (see mcp-admin.ts's write_bundle_file/delete_bundle_file): copies the live
// bundle into a fresh staging dir, lets `mutate` edit that copy in place, then
// applies the exact same validation and swap installBundleZip uses above -- content
// allowlist and size caps, then loadBundle to catch a manifest that no longer
// resolves (an edited deckd.json, or a file the manifest depends on going missing)
// -- so a partial edit can never leave a broken bundle live, and swapBundleDir
// stays the only rename-swap in the codebase.
//
// mutate must run entirely synchronously, matching swapBundleDir's own invariant:
// everything between the staging copy and the swap below is synchronous fs calls
// with no await point, so mutate returning before validateBundleContents/loadBundle
// run is what guarantees the staged tree they inspect is exactly what mutate left it
// as. mutate's declared type (`=> void`) does not by itself reject an async function
// -- TypeScript's void-return compatibility rule lets one through -- so the guard
// below checks at runtime and refuses to proceed past a thenable return instead of
// silently validating and swapping a staging dir mutate hasn't finished writing to.
export async function applyBundleEdit(
  cfg: Config,
  bundleRef: BundleRef & BundleWriter,
  mutate: (stagingDir: string) => void,
): Promise<BundleUploadOutcome> {
  const stagingDir = join(dirname(cfg.bundleDir), `bundle.edit-${randomUUID()}`);
  try {
    copyDirSkippingSymlinks(bundleRef.current().dir, stagingDir);
    const mutateResult: unknown = mutate(stagingDir);
    if (isThenable(mutateResult)) {
      throw new Error("applyBundleEdit's mutate callback must be synchronous, but returned a promise/thenable");
    }
    validateBundleContents(stagingDir);
    loadBundle(stagingDir);

    const finalBundle = swapBundleDir(cfg.bundleDir, stagingDir);
    markUploaded(finalBundle.dir);
    bundleRef.replace(finalBundle);
    return { bundle: finalBundle, summary: bundleSummary(finalBundle) };
  } catch (e: unknown) {
    throw relativizeStagingPath(e, stagingDir);
  } finally {
    // A no-op once swapBundleDir has moved stagingDir into place; only actually
    // cleans up when mutate or a validation step above threw first.
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
