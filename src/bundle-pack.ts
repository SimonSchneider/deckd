import { existsSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveBundle, readBundleManifest, type Manifest } from "./bundle.js";
import {
  copyDirSkippingSymlinks, isExcludedDeckEntry, isOsJunkEntry, listExampleDecks, stripOsJunk, zipDirectory,
} from "./artifacts.js";

export interface PackOptions {
  cwd: string;
  outPath: string;
  theme?: string;
  assets?: string;
  examples?: string;
  guide?: string;
}

export interface PackResult {
  outPath: string;
  manifest: Manifest;
  fileCount: number;
}

// deckd pack's job: read (or, for a repo with no deckd.json of its own, synthesize
// from --theme/--assets/--examples/--guide) a manifest, validate it resolves inside
// cwd the same way an uploaded bundle would (resolveBundle applies the identical
// traversal/symlink checks loadBundle does), then zip deckd.json plus only the
// manifest-referenced paths -- nothing else in cwd. Never writes deckd.json into
// the source repo itself, and never touches Chrome or marp (spec decision 4: pack
// must not require Chrome).
function resolveManifestForPack(cwd: string, opts: PackOptions): Manifest {
  if (existsSync(join(cwd, "deckd.json"))) return readBundleManifest(cwd);
  if (opts.theme === undefined) {
    throw new Error(
      `no deckd.json found in ${cwd}, and --theme was not given -- pack needs at least --theme to synthesize ` +
        "a manifest for a repo with no deckd.json of its own",
    );
  }
  return { theme: opts.theme, assets: opts.assets, examples: opts.examples, guide: opts.guide };
}

function copyFileInto(stagingDir: string, srcAbs: string, relPath: string): void {
  const dest = join(stagingDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcAbs, dest);
}

// Copies every example deck under examplesDir into <stagingDir>/<relPath>/<slug>,
// applying the same per-deck exclusions (charts.py, __pycache__, preview/, rendered
// .pdf/.pptx, symlinks) every other deck-content copy in this codebase applies -- so
// a packed example already passes bundle-upload.ts's content allowlist without
// further cleanup.
function copyExamplesInto(stagingDir: string, examplesDir: string, relPath: string): void {
  for (const slug of listExampleDecks(examplesDir)) {
    const srcDeckDir = join(examplesDir, slug);
    const destDeckDir = join(stagingDir, relPath, slug);
    mkdirSync(destDeckDir, { recursive: true });
    for (const entry of readdirSync(srcDeckDir)) {
      if (isExcludedDeckEntry(entry) || isOsJunkEntry(entry)) continue;
      const s = join(srcDeckDir, entry);
      const st = lstatSync(s);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) copyDirSkippingSymlinks(s, join(destDeckDir, entry));
      else copyFileSync(s, join(destDeckDir, entry));
    }
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

export async function packBundle(opts: PackOptions): Promise<PackResult> {
  const cwd = resolve(opts.cwd);
  const manifest = resolveManifestForPack(cwd, opts);
  // Validates theme exists, assets/examples/guide (if declared) exist, and nothing
  // escapes cwd or passes through a symlink -- the same checks a bundle gets on
  // upload, run here before anything is copied or zipped.
  const bundle = resolveBundle(cwd, manifest);

  const stagingDir = mkdtempSync(join(tmpdir(), "deckd-pack-"));
  try {
    copyFileInto(stagingDir, bundle.themeCss, manifest.theme);
    if (manifest.assets !== undefined && bundle.assetsDir !== undefined) {
      copyDirSkippingSymlinks(bundle.assetsDir, join(stagingDir, manifest.assets));
    }
    if (manifest.examples !== undefined && bundle.examplesDir !== undefined) {
      copyExamplesInto(stagingDir, bundle.examplesDir, manifest.examples);
    }
    if (manifest.guide !== undefined && bundle.guidePath !== undefined) {
      copyFileInto(stagingDir, bundle.guidePath, manifest.guide);
    }
    writeFileSync(join(stagingDir, "deckd.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const outPath = resolve(opts.outPath);
    rmSync(outPath, { force: true });
    await zipDirectory(stagingDir, outPath);

    return { outPath, manifest, fileCount: countFiles(stagingDir) };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// Zips a live, already-installed bundle directory as-is for GET /api/bundle/download,
// reusing the same zipDirectory helper packBundle uses above. Unlike packBundle -- which
// stages only a source repo's manifest-referenced paths, since a repo may hold other
// content too -- a bundle already installed under a BundleRef contains *only* what
// installBundleZip (or applyBundleEdit) validated and swapped in, so the whole
// directory is safe to zip directly, with no restaging step. stripOsJunk still runs
// first, in place, since the bundle dir is a plain directory on disk that OS-level
// noise (a .DS_Store from Finder browsing it) can land in outside deckd's own
// ingestion paths -- deckd owns this directory, so deleting junk from it is safe.
export async function zipBundleDir(bundleDir: string, outPath: string): Promise<void> {
  stripOsJunk(bundleDir);
  rmSync(outPath, { force: true });
  await zipDirectory(bundleDir, outPath);
}
