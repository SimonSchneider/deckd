import {
  existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, renameSync, rmSync, lstatSync, copyFileSync, utimesSync,
  createReadStream, createWriteStream, constants as fsConstants, type Stats,
} from "node:fs";
import { join, basename, dirname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import JSZip from "jszip";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ASSET_RE = /^[\w][\w .-]{0,80}\.(png|jpg|jpeg|svg|webp)$/i;
const MAX_ASSET = 20 * 1024 * 1024;

// Caps for a deck-import zip (seedDeck's { kind: "zip" } path), mirroring
// bundle-upload.ts's MAX_BUNDLE_FILE_BYTES/MAX_BUNDLE_TOTAL_BYTES: a deck import has
// no size cap of its own otherwise, so a small, highly compressible zip could
// decode to an unbounded amount of data on disk.
export const MAX_DECK_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DECK_IMPORT_TOTAL_BYTES = 100 * 1024 * 1024;

// Name-based exclusion rules shared by every path that copies or mirrors a deck's
// entries onto the host: syncDeckMirror (host-render.ts) mirrors an own deck into the
// host renderer's scratch dir, syncCanonicalDeckCache below caches a canonical
// deck for preview, and bundle-pack.ts's copyExamplesInto packs a canonical deck into
// a bundle zip. All three must agree on what to leave out, so this is the one place
// the rule lives. charts.py/__pycache__/*.py are agent-authored and untrusted, so
// they must never reach the host process; the check is case-insensitive because
// deckDir may sit on a case-insensitive filesystem (APFS). preview/, *.pdf, and
// *.pptx are render *output* -- renderPreviews' own generated PNGs (see
// host-render.ts's copyPreviewsBack) and a deck's own rendered exports -- not deck
// content, so re-mirroring, re-caching, or packing them would only grow storage
// without bound, and a packed *.pdf/*.pptx would also fail bundle-upload.ts's content
// allowlist on the very next upload. Symlink checks are deliberately not part of
// this predicate: they need an lstat against each call site's own root, which a pure
// name check can't do.
export function isExcludedDeckEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "charts.py" || lower === "__pycache__" || lower.endsWith(".py") || lower === "preview"
    || lower.endsWith(".pdf") || lower.endsWith(".pptx")
  );
}

// themeName is omitted (rather than defaulted to some fixed name) when the caller
// has none to give -- see deriveThemeName below, and seedDeck's "blank" case, which
// is the only caller that ever supplies one.
function blankMarkdown(title: string, themeName: string | undefined): string {
  const themeLine = themeName === undefined ? "" : `theme: ${themeName}\n`;
  return `---
marp: true
${themeLine}paginate: true
title: ${title}
---

<!-- _class: title -->

# ${title}
`;
}

// Marp/Marpit identify a theme by a name declared in its own CSS, on a comment
// line shaped like `/* @theme <name> */` (see marpit's own theme.js) -- not by the
// CSS file's path. A blank deck's front matter must name the bundle's live theme by
// that same name, or Marp silently falls back to its own default theme instead of
// the bundle's, so this reads it straight out of the CSS rather than assuming any
// fixed name. Returns undefined if the file has no such comment (the CSS declares
// no theme at all, or the marker line is missing) -- the caller omits the front
// matter's theme line entirely in that case, rather than emitting one it can't back
// up.
export function deriveThemeName(themeCssPath: string): string | undefined {
  const css = readFileSync(themeCssPath, "utf8");
  const match = /\/\*\s*@theme\s+([\w-]+)\s*\*\//.exec(css);
  return match?.[1];
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s === "" ? "deck" : s;
}

export function listDecks(appDir: string): string[] {
  const root = join(appDir, "presentations");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, "slides.md")))
    .sort();
}

// Lists example decks straight from a bundle's examplesDir: unlike a session
// appDir (listDecks above), examplesDir already points at the decks themselves --
// there is no extra "presentations" segment to descend through first.
export function listExampleDecks(examplesDir: string): string[] {
  if (!existsSync(examplesDir)) return [];
  return readdirSync(examplesDir)
    .filter((d) => existsSync(join(examplesDir, d, "slides.md")))
    .sort();
}

function pathsFor(dir: string, slug: string): { dir: string; slides: string; pdf: string; pptx: string } {
  return { dir, slides: join(dir, "slides.md"), pdf: join(dir, `${slug}.pdf`), pptx: join(dir, `${slug}-editable.pptx`) };
}

export function deckPaths(appDir: string, slug: string): { dir: string; slides: string; pdf: string; pptx: string } {
  return pathsFor(join(appDir, "presentations", slug), slug);
}

// Same shape as deckPaths, for a deck read straight out of a bundle's examplesDir
// (see listExampleDecks's comment on why the join differs from deckPaths).
export function exampleDeckPaths(examplesDir: string, slug: string): { dir: string; slides: string; pdf: string; pptx: string } {
  return pathsFor(join(examplesDir, slug), slug);
}

export type Seed =
  | { kind: "blank"; title: string; themeName?: string }
  | { kind: "md"; content: string }
  | { kind: "zip"; zipPath: string };

// A malicious zip can carry an absolute path or a ".." segment to write outside
// the extraction dir (zip-slip). jszip resolves ".." segments away by itself when
// it computes a directory entry's name (no trace of the raw name survives to
// inspect), which is fine -- a resolved directory name can never land outside the
// extraction root either way, so there is nothing unsafe left to catch there. A
// FILE entry's true raw name survives on `unsafeOriginalName` specifically so a
// caller can still see it, which is what this checks. Throws the same
// "unsafe zip entry: <name>" shape `unzip -Z1` parsing used to.
function assertSafeEntryName(rawName: string): void {
  if (rawName.startsWith("/") || rawName.includes("\\") || rawName.split("/").includes("..")) {
    throw new Error(`unsafe zip entry: ${rawName}`);
  }
}

// jszip exposes a zip entry's Unix mode bits (when the zip was built on a
// Unix-like system, as `unzip`'s own symlink support already assumed) via
// unixPermissions; the top nibble is the file-type field POSIX's S_IFMT mask
// extracts, and S_IFLNK is the symlink type within it -- the same test `lstat`
// uses on a real filesystem entry, just read out of the zip's stored metadata
// instead of an inode.
function isSymlinkEntry(entry: JSZip.JSZipObject): boolean {
  const mode = entry.unixPermissions;
  return typeof mode === "number" && (mode & fsConstants.S_IFMT) === fsConstants.S_IFLNK;
}

export interface ZipSizeCaps {
  maxFileBytes: number;
  maxTotalBytes: number;
}

// A zip's stored uncompressed-size metadata is untrusted: a highly compressible
// payload (e.g. a zip of zeros) can carry an accurate but enormous declared size,
// or the metadata itself could be crafted to say something smaller than what
// actually decompresses. Counting the real bytes flowing through the decompression
// stream, chunk by chunk, catches either case the moment the cap is crossed instead
// of trusting anything the zip itself claims.
function capEnforcer(entryName: string, caps: ZipSizeCaps, totalRef: { bytes: number }): Transform {
  let fileBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      fileBytes += chunk.length;
      totalRef.bytes += chunk.length;
      if (fileBytes > caps.maxFileBytes) {
        callback(new Error(`zip entry too large: ${entryName} exceeds the per-file cap of ${caps.maxFileBytes} bytes`));
        return;
      }
      if (totalRef.bytes > caps.maxTotalBytes) {
        callback(new Error(`zip exceeds the total decoded size cap of ${caps.maxTotalBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

// Extracts a zip's entries onto disk under destDir, replacing the old
// `unzip`/assertSafeZip (`unzip -Z1`) pipeline so deckd has no dependency on an
// external zip/unzip binary. In order: every entry's name is validated up front
// (see assertSafeEntryName) with no filesystem side effects at all -- destDir
// itself is only created once that pass is clean, so a rejected zip leaves
// nothing behind, matching assertSafeZip's old behavior. Entries are then
// written, skipping a symlink entry outright (see isSymlinkEntry) instead of
// creating it and relying solely on a post-extraction sweep -- callers should
// still run stripSymlinks afterward as belt-and-braces -- and skipping any entry
// with an isOsJunkEntry path segment (so junk, or anything nested under a junk
// directory, is never written at all).
//
// When `caps` is given, each entry's decompressed bytes are counted as they
// stream off jszip's decompressor (see capEnforcer) rather than validated only
// after the fact against what landed on disk -- a zip bomb (a small, highly
// compressible payload) would otherwise have its full decompressed content
// written to disk before any size check ever ran. Exceeding either cap aborts
// the extraction immediately and removes everything written so far under
// destDir, so a rejected zip leaves nothing behind on disk, the same guarantee
// assertSafeEntryName gives for an unsafe entry name.
export async function extractZip(
  zipBytes: Buffer,
  destDir: string,
  log: (msg: string) => void = () => {},
  caps?: ZipSizeCaps,
): Promise<void> {
  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    assertSafeEntryName(entry.unsafeOriginalName ?? entry.name);
  }
  mkdirSync(destDir, { recursive: true });
  const totalRef = { bytes: 0 };
  try {
    for (const entry of entries) {
      const segments = entry.name.split("/").filter((s) => s !== "");
      if (segments.some((s) => isOsJunkEntry(s))) {
        log(`skipped OS-junk zip entry: ${entry.name}`);
        continue;
      }
      const dest = join(destDir, ...segments);
      if (entry.dir) {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      if (isSymlinkEntry(entry)) {
        log(`skipped symlink zip entry: ${entry.name}`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      if (caps === undefined) {
        await pipeline(entry.nodeStream(), createWriteStream(dest));
      } else {
        await pipeline(entry.nodeStream(), capEnforcer(entry.name, caps, totalRef), createWriteStream(dest));
      }
    }
  } catch (e: unknown) {
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
}

// Zips every file under srcDir into outFile as a flat, relative-path archive,
// skipping symlinks and any entry whose relative path (posix-style, no leading
// "./") the caller's exclude predicate rejects. Replaces the old `zip -r` child
// process with jszip so deckd has no dependency on an external zip binary; the
// output need not match `zip`'s bytes, only its logical file contents.
export async function zipDirectory(
  srcDir: string,
  outFile: string,
  exclude: (relPath: string) => boolean = () => false,
): Promise<void> {
  const zip = new JSZip();
  addTreeToZip(zip, srcDir, "", exclude);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(outFile, buf);
}

function addTreeToZip(zip: JSZip, dir: string, prefix: string, exclude: (relPath: string) => boolean): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    if (exclude(rel)) continue;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      addTreeToZip(zip, abs, rel, exclude);
    } else {
      zip.file(rel, createReadStream(abs));
    }
  }
}

// unzip used to extract a zip's symlink entries as real filesystem symlinks (it
// honors the Unix mode bits in the zip's external attributes); extractZip above
// now skips them outright instead, so this should find nothing on a zip it
// processed -- kept as belt-and-braces (and to cover a symlink landing in a deck
// dir some other way) rather than removed. Exported for bundle-upload.ts, which
// applies the same rule to an uploaded bundle.
export function stripSymlinks(root: string, log: (msg: string) => void): void {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) {
      log(`stripped symlink from imported zip: ${p}`);
      rmSync(p, { force: true });
    } else if (stat.isDirectory()) {
      stripSymlinks(p, log);
    }
  }
}

// Case-insensitive detector for filesystem noise a zip tool embeds without the user
// asking for it: macOS Finder's __MACOSX/ sibling tree of AppleDouble "._*" resource-fork
// files and .DS_Store, Windows Explorer's Thumbs.db/desktop.ini/ehthumbs.db. Takes a
// single directory-entry name, not a full path, so a caller walking a tree (stripOsJunk
// below, copyDirSkippingSymlinks, syncCanonicalDeckCache) applies it once per entry as
// it recurses. The "._" check is anchored to that literal two-character prefix so it
// never matches an ordinary dotfile like ".gitignore" or ".env".
const OS_JUNK_BASENAMES = new Set(["thumbs.db", "desktop.ini", "ehthumbs.db", ".ds_store"]);
export function isOsJunkEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "__macosx" || lower.startsWith("._") || OS_JUNK_BASENAMES.has(lower);
}

// Recursively deletes every OS-junk entry (see isOsJunkEntry) from root, in place,
// before content validation or seedDeck's single-top-level-folder heuristic below ever
// sees it: a zip built by macOS Finder or Windows Explorer carries this metadata
// whether the user asked for it or not, and __MACOSX/ alongside a deck's real folder
// otherwise breaks that heuristic (two top-level entries instead of one). Exported for
// bundle-upload.ts's installBundleZip/applyBundleEdit, and safe to call directly on a
// live, deckd-owned directory (a bundle dir, a session's deck dir) since junk is never
// meaningful content worth preserving.
export function stripOsJunk(root: string, log: (msg: string) => void = () => {}): void {
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (isOsJunkEntry(entry)) {
      log(`stripped OS-junk entry: ${p}`);
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    if (lstatSync(p).isDirectory()) stripOsJunk(p, log);
  }
}

// Detects whether an extracted zip's real content root is `root` itself or a single
// wrapper directory a zip tool added around it -- Finder (zipping a folder, not its
// contents) and macOS's own "Compress" both do this, and so does a `deckd pack`/CLI
// export re-zipped by hand. `markerFileName` is whatever file identifies "this is the
// thing we're looking for": "slides.md" for a deck-import zip, "deckd.json" for a
// bundle zip. Returns `root` if the marker is already there, the single wrapper
// subdirectory if root contains exactly one entry and the marker is at ITS root, or
// null if neither holds -- including when root holds more than one top-level entry,
// which is never guessed at. Callers should strip symlinks and OS junk (see
// stripSymlinks/stripOsJunk) before calling this, or a leftover __MACOSX/junk entry
// would make an otherwise-single-wrapper zip look like it has two top-level entries.
export function resolveZipRoot(root: string, markerFileName: string): string | null {
  if (existsSync(join(root, markerFileName))) return root;
  const entries = readdirSync(root);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only !== undefined && existsSync(join(root, only, markerFileName))) {
    return join(root, only);
  }
  return null;
}

export async function seedDeck(appDir: string, slug: string, seed: Seed, log: (msg: string) => void = console.warn): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug: ${slug}`);
  const p = deckPaths(appDir, slug);
  mkdirSync(p.dir, { recursive: true });
  if (seed.kind === "blank") {
    writeFileSync(p.slides, blankMarkdown(seed.title, seed.themeName));
  } else if (seed.kind === "md") {
    writeFileSync(p.slides, seed.content);
  } else {
    // Exported zips wrap the deck in its original slug dir; flatten one level if needed.
    const tmp = p.dir + ".unzip";
    rmSync(tmp, { recursive: true, force: true });
    await extractZip(readFileSync(seed.zipPath), tmp, log, {
      maxFileBytes: MAX_DECK_IMPORT_FILE_BYTES,
      maxTotalBytes: MAX_DECK_IMPORT_TOTAL_BYTES,
    });
    stripSymlinks(tmp, log);
    stripOsJunk(tmp, log);
    const src = resolveZipRoot(tmp, "slides.md");
    if (src === null) { rmSync(tmp, { recursive: true, force: true }); throw new Error("zip has no slides.md"); }
    rmSync(p.dir, { recursive: true, force: true });
    renameSync(src, p.dir);
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function saveAsset(appDir: string, slug: string, filename: string, data: Buffer): string {
  const name = basename(filename);
  if (name !== filename || !ASSET_RE.test(name)) throw new Error(`bad asset name: ${filename}`);
  if (data.length > MAX_ASSET) throw new Error("asset too large");
  const dir = join(deckPaths(appDir, slug).dir, "images");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  return `images/${name}`;
}

// Path allowed to include subdirectories (e.g. "charts/plot.svg"), unlike saveAsset's
// bare filename; a ".." segment is checked separately since the character class here
// permits dots and slashes for legitimate subdirectory paths.
const ASSET_PATH_RE = /^[\w][\w./-]{0,160}\.(png|jpe?g|svg|webp)$/i;

// Like saveAsset, but for a caller (MCP's upload_asset) that picks the subdirectory
// itself rather than always landing in images/. relPath is untrusted, AI-supplied
// input, so every segment is validated before anything touches the filesystem: no
// absolute path, no ".." traversal, an allowed extension, a size under maxBytes, and
// no symlink at the destination or at any directory the path walks through -- the same
// defense saveAsset and the render-mirroring code apply elsewhere in this file.
// lstatSync, but "doesn't exist" comes back as null instead of throwing --
// unlike existsSync, this never follows a symlink to decide presence, so a
// dangling symlink (its target missing) still reports its own stat rather than
// being read as "nothing here".
function lstatIfPresent(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export function saveAssetAt(appDir: string, slug: string, relPath: string, data: Buffer, maxBytes: number): string {
  const firstSeg = relPath.split("/")[0] ?? "";
  if (
    relPath.startsWith("/") ||
    relPath.split("/").includes("..") ||
    !ASSET_PATH_RE.test(relPath) ||
    isExcludedDeckEntry(firstSeg)
  ) {
    throw new Error(`bad asset path: ${relPath}`);
  }
  if (data.length > maxBytes) throw new Error(`asset too large: ${data.length} bytes (max ${maxBytes})`);
  const deckDir = deckPaths(appDir, slug).dir;
  const dest = resolve(deckDir, relPath);
  if (dest !== deckDir && !dest.startsWith(deckDir + sep)) throw new Error(`bad asset path: ${relPath}`);

  let dir = deckDir;
  for (const seg of dirname(relative(deckDir, dest)).split(sep)) {
    if (seg === "" || seg === ".") continue;
    dir = join(dir, seg);
    const st = lstatIfPresent(dir);
    if (st !== null && st.isSymbolicLink()) throw new Error(`bad asset path: ${relPath} (symlink in path)`);
  }
  const destSt = lstatIfPresent(dest);
  if (destSt !== null && destSt.isSymbolicLink()) throw new Error(`bad asset path: ${relPath} (symlink at destination)`);

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  return relative(deckDir, dest);
}

export async function exportZip(appDir: string, slug: string, outFile: string): Promise<void> {
  const p = deckPaths(appDir, slug);
  rmSync(outFile, { force: true });
  // A session's deck dir is deckd-owned, so any OS junk sitting in it (e.g. Finder
  // dropping a .DS_Store while the user browsed it) is deleted in place rather than
  // shipped in the export -- same reasoning as bundle-pack.ts's zipBundleDir.
  stripOsJunk(p.dir);
  // preview/ holds host-rendered slide PNGs (see host-render.ts's renderPreviews):
  // derived output for an AI to look at, not deck content, so it never ships in a
  // user-facing export.
  await zipDirectory(p.dir, outFile, (rel) => rel === "preview" || rel.startsWith("preview/"));
}

// Exported for bundle-pack.ts's `deckd pack`, which copies a manifest's
// assets/examples directories into its zip staging area with the same symlink
// exclusion every other deck-content copy in this file applies. Also skips OS junk
// (see isOsJunkEntry) so it never gets staged into a zip in the first place -- unlike
// exportZip/zipBundleDir above, the source here may be a caller's own repo (e.g.
// `deckd pack`'s source checkout), so junk is skipped during copy rather than deleted
// from the source.
//
// Preserves each copied file's mtime (copyFileSync alone stamps "now" instead). This
// matters for bundle-upload.ts's applyBundleEdit, whose stage-validate-swap copies the
// entire live bundle before applying a single-file edit: without preservation, EVERY
// file's mtime -- including one `mutate` never touches, like deckd.json during a
// theme.css-only write -- would reset to "now" on every edit, and a client's earlier
// read of that untouched file's mtime would look stale for a later write to it that
// never actually raced anything. utimesSync's fractional-seconds precision keeps the
// round-trip within the same sub-millisecond tolerance every base_mtime conflict
// check in this codebase already applies (`Math.abs(current - base_mtime) > 1`).
export function copyDirSkippingSymlinks(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isOsJunkEntry(entry)) continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    const stat = lstatSync(s);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copyDirSkippingSymlinks(s, d);
    } else {
      copyFileSync(s, d);
      utimesSync(d, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    }
  }
}

// Builds a read-only, host-render-safe copy of a canonical (non-own) deck under
// cfg.canonicalCacheDir, refreshed from the bundle's examplesDir on every call.
// Every entry is copied except what isExcludedDeckEntry excludes (*.py files,
// __pycache__, preview/) and symlinks — the same exclusion rules host-render's
// syncDeckMirror applies to an own deck — so any asset directory a deck keeps
// (images/, charts/, ...) is cached, while charts.py (canonical decks are
// previewed without running their charts; a deck whose chart output isn't
// committed may simply fail to render, which is accepted) never is. This is the
// only path a non-own deck's render may use for `deckDir`: it must never point
// into the bundle itself, because the host renderer copies its output back into
// `deckDir` — pointing that at the bundle would write render output into
// uploaded, shared content.
export function syncCanonicalDeckCache(examplesDir: string, cacheDir: string, slug: string): string {
  const src = exampleDeckPaths(examplesDir, slug).dir;
  const dest = deckPaths(cacheDir, slug).dir;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return dest;
  for (const entry of readdirSync(src)) {
    if (isExcludedDeckEntry(entry) || isOsJunkEntry(entry)) continue;
    const s = join(src, entry);
    if (lstatSync(s).isSymbolicLink()) continue;
    if (lstatSync(s).isDirectory()) copyDirSkippingSymlinks(s, join(dest, entry));
    else copyFileSync(s, join(dest, entry));
  }
  return dest;
}
