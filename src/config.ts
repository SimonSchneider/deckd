import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  port: number;
  dbPath: string;
  devUser: string;
  bundleDir: string;
  scratchDir: string;
  canonicalCacheDir: string;
  localDecksRoot: string;
  chromePath: string;
}

// checkLayout (host-render.ts) spawns Chrome directly rather than depending on
// puppeteer, so the binary has to be located by hand: an explicit override wins,
// then the CHROME_PATH convention other tools already use, then the one place a
// plain `brew install`-free macOS Chrome install always puts it. None of those
// existing lets a headless layout check run at all, so that's a startup failure,
// not a deferred one surfaced only when a check_deck call happens to run.
const MAC_CHROME_DEFAULT = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Exported for cli.ts, which needs the exact same resolution (env override, then the
// CHROME_PATH convention, then the macOS default) for its `check` command and a
// `render --pptx`, without going through loadConfig's other, server-only defaults.
export function resolveChromePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.DECKD_CHROME_PATH;
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromChromePath = env.CHROME_PATH;
  if (fromChromePath !== undefined && fromChromePath !== "") return fromChromePath;
  if (existsSync(MAC_CHROME_DEFAULT)) return MAC_CHROME_DEFAULT;
  throw new Error(
    `no Chrome binary found for layout checks: set DECKD_CHROME_PATH or CHROME_PATH, or install Chrome at ${MAC_CHROME_DEFAULT}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // Anchor for every data dir below, so a bare `npm run dev` has somewhere to put
  // its sqlite db, bundle, scratch and deck directories with zero required env.
  const dataDir = env.DECKD_DATA_DIR ?? join(process.cwd(), "data");
  return {
    port: Number(env.DECKD_PORT ?? 8790),
    dbPath: env.DECKD_DB ?? join(dataDir, "deckd.sqlite3"),
    devUser: env.DECKD_DEV_USER ?? "dev@localhost",
    // The composition root loads this once at startup (bundle.ts's loadBundle) and
    // passes the resolved Bundle to every module that needs it; nothing downstream
    // of index.ts reads bundleDir directly.
    bundleDir: env.DECKD_BUNDLE_DIR ?? join(dataDir, "bundle"),
    scratchDir: env.DECKD_SCRATCH_DIR ?? join(dataDir, "render-scratch"),
    // Holds read-only cache copies of canonical (non-own) decks used to preview them
    // without ever rendering with a deckDir that points into the bundle itself.
    canonicalCacheDir: env.DECKD_CANONICAL_CACHE_DIR ?? join(dataDir, "canonical-cache"),
    // Root for a deck's plain <localDecksRoot>/<deckId>/presentations/<slug>/
    // directory -- every deck is one of these; there is no other backing store.
    localDecksRoot: env.DECKD_LOCAL_DECKS_DIR ?? join(dataDir, "local-decks"),
    chromePath: resolveChromePath(env),
  };
}
