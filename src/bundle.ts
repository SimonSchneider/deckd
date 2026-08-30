import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

// A bundle is a directory + manifest (deckd.json at its root) carrying everything
// deckd needs to render decks that isn't deckd's own code: a prebuilt theme, and
// optionally a shared-asset dir, a directory of example decks, and an authoring
// guide.
export interface Bundle {
  dir: string;
  themeCss: string;
  assetsDir?: string;
  examplesDir?: string;
  guidePath?: string;
  // Always present, with every key defaulted -- unlike the other Bundle fields,
  // this has no "absent" state a caller needs to branch on (see RENDER_DEFAULTS).
  render: RenderConfig;
}

// The manifest's own "render" block, as authored: every key optional, and only the
// keys actually given are validated/kept here (see readManifest's parseRenderConfig)
// -- defaulting happens later, in resolveBundle, so readBundleManifest's "as
// authored" summary (bundle-upload.ts's GET /api/bundle) never shows a default the
// manifest didn't actually declare.
export interface RenderManifestConfig {
  imageScale?: number;
  pdfOutlines?: boolean;
  pdfNotes?: boolean;
}

// The normalized form on Bundle: every key defaulted, for host-render.ts to read
// directly with no `?? default` fallback of its own.
export interface RenderConfig {
  imageScale: number;
  pdfOutlines: boolean;
  pdfNotes: boolean;
}

// imageScale defaults to 2 (not marp's own default of 1) for agent-facing crispness
// in get_slide_previews' PNGs -- humans read the vector PDF, which imageScale never
// touches. pdfOutlines/pdfNotes default to off, matching marp-cli's own defaults.
const RENDER_DEFAULTS: RenderConfig = { imageScale: 2, pdfOutlines: false, pdfNotes: false };
const RENDER_ALLOWED_KEYS: ReadonlySet<string> = new Set(["imageScale", "pdfOutlines", "pdfNotes"]);
const RENDER_IMAGE_SCALE_MIN = 0.5;
const RENDER_IMAGE_SCALE_MAX = 4;

// Exported for bundle-upload.ts's GET /api/bundle summary, which reports the
// manifest as authored rather than loadBundle's resolved absolute paths.
export interface Manifest {
  theme: string;
  assets?: string;
  examples?: string;
  guide?: string;
  render?: RenderManifestConfig;
}

const MANIFEST_NAME = "deckd.json";
type ManifestKey = "theme" | "assets" | "examples" | "guide";

// Validates raw.render (deckd.json's optional "render" block) and returns it
// unchanged, keys and all -- allowlisted rather than passed through, so a typo'd key
// (e.g. "imageScael") is rejected loudly instead of silently no-op'ing. Absent
// entirely is valid (the feature is simply off); defaulting the keys it doesn't
// declare happens later, in normalizeRenderConfig.
function parseRenderConfig(raw: unknown, manifestPath: string): RenderManifestConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new Error(`bundle manifest "render" must be a JSON object: ${manifestPath}`);

  const result: RenderManifestConfig = {};
  for (const key of Object.keys(raw)) {
    if (!RENDER_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `bundle manifest "render.${key}" is not a recognized key (allowed: imageScale, pdfOutlines, pdfNotes): ${manifestPath}`,
      );
    }
  }
  if (raw.imageScale !== undefined) {
    const v = raw.imageScale;
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new Error(`bundle manifest "render.imageScale" must be a number: ${manifestPath}`);
    }
    if (v < RENDER_IMAGE_SCALE_MIN || v > RENDER_IMAGE_SCALE_MAX) {
      throw new Error(
        `bundle manifest "render.imageScale" must be between ${RENDER_IMAGE_SCALE_MIN} and ${RENDER_IMAGE_SCALE_MAX}: ${manifestPath}`,
      );
    }
    result.imageScale = v;
  }
  if (raw.pdfOutlines !== undefined) {
    if (typeof raw.pdfOutlines !== "boolean") {
      throw new Error(`bundle manifest "render.pdfOutlines" must be a boolean: ${manifestPath}`);
    }
    result.pdfOutlines = raw.pdfOutlines;
  }
  if (raw.pdfNotes !== undefined) {
    if (typeof raw.pdfNotes !== "boolean") {
      throw new Error(`bundle manifest "render.pdfNotes" must be a boolean: ${manifestPath}`);
    }
    result.pdfNotes = raw.pdfNotes;
  }
  return result;
}

// Fills in every key a manifest's render block left unset (including the block
// being absent entirely) with RENDER_DEFAULTS -- the only place defaults are
// applied, so Bundle.render is always fully populated.
function normalizeRenderConfig(render: RenderManifestConfig | undefined): RenderConfig {
  return {
    imageScale: render?.imageScale ?? RENDER_DEFAULTS.imageScale,
    pdfOutlines: render?.pdfOutlines ?? RENDER_DEFAULTS.pdfOutlines,
    pdfNotes: render?.pdfNotes ?? RENDER_DEFAULTS.pdfNotes,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readManifest(manifestPath: string): Manifest {
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    throw new Error(`bundle manifest not found: ${manifestPath}`);
  }
  // Every other manifest entry (theme/assets/examples/guide) is symlink-checked via
  // resolveManifestPath; deckd.json itself must be too, or an uploaded bundle could
  // point its own manifest file at an arbitrary target outside the bundle dir.
  if (manifestStat.isSymbolicLink()) {
    throw new Error(`bundle manifest must not be a symlink: ${manifestPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e: unknown) {
    throw new Error(`bundle manifest is not valid JSON: ${manifestPath} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isPlainObject(raw)) throw new Error(`bundle manifest must be a JSON object: ${manifestPath}`);

  const theme = raw.theme;
  if (typeof theme !== "string" || theme === "") {
    throw new Error(`bundle manifest is missing the required "theme" path: ${manifestPath}`);
  }
  const optionalString = (key: "assets" | "examples" | "guide"): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") {
      throw new Error(`bundle manifest "${key}" must be a non-empty string path: ${manifestPath}`);
    }
    return v;
  };
  return {
    theme,
    assets: optionalString("assets"),
    examples: optionalString("examples"),
    guide: optionalString("guide"),
    render: parseRenderConfig(raw.render, manifestPath),
  };
}

// Reads and validates a bundle dir's manifest without resolving/checking its entries
// against the filesystem -- the as-authored theme/assets/examples/guide strings,
// for bundle-upload.ts's GET /api/bundle summary. loadBundle below is still the only
// function that establishes a Bundle is actually valid (theme exists, no symlinks,
// etc.); this is display-only.
export function readBundleManifest(bundleDir: string): Manifest {
  return readManifest(join(resolve(bundleDir), MANIFEST_NAME));
}

// Resolves relPath against bundleDir, requiring it to land strictly inside
// bundleDir (no ".." segment, no absolute path) and requiring every path segment
// that already exists on disk -- including the final entry itself -- to be a real
// file or directory, never a symlink. A bundle is uploadable, untrusted content
// (see spec decision 3: PUT /api/bundle validation), so a manifest entry must not
// be usable to escape the bundle directory via traversal or a symlink pointing
// outside it. `label` only names the offending entry in the thrown message; it
// need not be a manifest key -- exported as resolveBundlePath below for callers
// resolving an arbitrary in-bundle path that isn't a manifest entry at all (see
// mcp-admin.ts's read/write/delete_bundle_file).
function resolveManifestPath(bundleDir: string, label: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(`bundle manifest "${label}" must be a relative path, got an absolute one: ${relPath}`);
  }
  const segments = relPath.split("/");
  if (segments.includes("..")) {
    throw new Error(`bundle manifest "${label}" must not contain "..": ${relPath}`);
  }
  const dest = resolve(bundleDir, relPath);
  if (dest !== bundleDir && !dest.startsWith(bundleDir + sep)) {
    throw new Error(`bundle manifest "${label}" resolves outside the bundle: ${relPath}`);
  }
  let cur = bundleDir;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // segment doesn't exist yet; existence is checked per-entry by the caller
    }
    if (st.isSymbolicLink()) {
      throw new Error(`bundle manifest "${label}" must not be or contain a symlink: ${relPath}`);
    }
  }
  return dest;
}

// Public entry point for resolveManifestPath above, for a caller resolving a path
// that isn't one of the four fixed manifest keys -- e.g. mcp-admin.ts validating an
// arbitrary read/write/delete target against the live bundle dir. Applies the exact
// same traversal/symlink invariant a manifest entry gets; existence and file-vs-directory
// are the caller's own concern, same as for a manifest entry.
export function resolveBundlePath(bundleDir: string, label: string, relPath: string): string {
  return resolveManifestPath(bundleDir, label, relPath);
}

function resolveRequiredFile(bundleDir: string, key: "theme", relPath: string): string {
  const abs = resolveManifestPath(bundleDir, key, relPath);
  if (!existsSync(abs) || lstatSync(abs).isDirectory()) {
    throw new Error(`bundle "${key}" file not found: ${abs}`);
  }
  return abs;
}

function resolveOptionalDir(bundleDir: string, key: "assets" | "examples", relPath: string | undefined): string | undefined {
  if (relPath === undefined) return undefined;
  const abs = resolveManifestPath(bundleDir, key, relPath);
  if (!existsSync(abs) || !lstatSync(abs).isDirectory()) {
    throw new Error(`bundle "${key}" directory not found: ${abs}`);
  }
  return abs;
}

function resolveOptionalFile(bundleDir: string, key: "guide", relPath: string | undefined): string | undefined {
  if (relPath === undefined) return undefined;
  const abs = resolveManifestPath(bundleDir, key, relPath);
  if (!existsSync(abs) || lstatSync(abs).isDirectory()) {
    throw new Error(`bundle "${key}" file not found: ${abs}`);
  }
  return abs;
}

// Resolves and validates an already-parsed manifest against bundleDir, without
// touching deckd.json itself -- the shared core of loadBundle below, and reused by
// bundle-pack.ts's `deckd pack` to validate a manifest synthesized from CLI flags
// (a repo with no deckd.json of its own) before zipping, with nothing written to
// the source repo's filesystem.
export function resolveBundle(bundleDir: string, manifest: Manifest): Bundle {
  const dir = resolve(bundleDir);
  return {
    dir,
    themeCss: resolveRequiredFile(dir, "theme", manifest.theme),
    assetsDir: resolveOptionalDir(dir, "assets", manifest.assets),
    examplesDir: resolveOptionalDir(dir, "examples", manifest.examples),
    guidePath: resolveOptionalFile(dir, "guide", manifest.guide),
    render: normalizeRenderConfig(manifest.render),
  };
}

// Loads and validates a bundle directory's deckd.json manifest, returning resolved
// absolute paths for every entry it declares. Throws a clear error naming exactly
// what's wrong (missing manifest, missing theme, traversal, absolute path,
// symlinked entry, missing declared file/dir) rather than returning a partial or
// silently-wrong Bundle.
export function loadBundle(dir: string): Bundle {
  const bundleDir = resolve(dir);
  return resolveBundle(bundleDir, readManifest(join(bundleDir, MANIFEST_NAME)));
}

// The composition root loads exactly one Bundle at startup and, from then on, every
// module that needs it (server.ts, mcp.ts, host-render.ts) reads it through this
// mutable holder instead of capturing the Bundle value itself: PUT /api/bundle
// (see server.ts) swaps the holder's contents by calling replace(), and everything
// downstream picks up the new bundle on its very next operation, with no restart.
// `current()` rather than a plain property is what forces every call site to
// re-read it per operation instead of caching a stale destructured Bundle.
export interface BundleRef {
  current(): Bundle;
}

// Kept as a separate interface from BundleRef (rather than one interface with both
// methods) so a type can declare it only needs read access -- see mcp.ts's McpDeps
// and host-render.ts's HostRendererOptions, which take BundleRef alone: MCP has no
// bundle-management tools (spec decision 5), so its dependency type cannot even
// compile a call to replace(). Only server.ts's Deps (which serves PUT /api/bundle)
// takes the full BundleRef & BundleWriter.
export interface BundleWriter {
  replace(next: Bundle): void;
}

export function createBundleRef(initial: Bundle): BundleRef & BundleWriter {
  let current = initial;
  return {
    current: () => current,
    replace: (next: Bundle) => {
      current = next;
    },
  };
}
