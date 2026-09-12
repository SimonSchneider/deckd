import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DeckStore, type DeckRow } from "./store.js";
import { seedDeck, slugify, deriveThemeName, type Seed } from "./artifacts.js";
import type { Config } from "./config.js";
import type { BundleRef } from "./bundle.js";

// The decks root was "<data>/local-sessions" until the deck rename. An existing data
// dir still has its decks there, and the new default ("<data>/local-decks", see
// config.ts) would otherwise be created empty beside it -- the same silent-data-loss
// shape store.ts's assertDbPathNotAbandoningLegacy guards the db against. Renaming
// the directory is safe and complete (a deck is nothing but its directory plus its
// db row, and rows reference the root-relative id only), so it is done here rather
// than refused. Only fires for the default layout: an explicit DECKD_LOCAL_DECKS_DIR
// pointing elsewhere is left alone.
export function migrateLegacyDecksRoot(localDecksRoot: string): void {
  if (existsSync(localDecksRoot) || basename(localDecksRoot) !== "local-decks") return;
  const legacy = join(dirname(localDecksRoot), "local-sessions");
  if (!existsSync(legacy)) return;
  renameSync(legacy, localDecksRoot);
}

// A deck is a plain directory: no sandboxd app, no container, no toolkit
// copies, no CLAUDE.md (an external AI gets its guidance from the MCP tools
// instead). Rendering is host-only (see render.ts), so there is nothing here to
// slim, restart, or wait on.
export class DeckService {
  constructor(private store: DeckStore, private cfg: Config, private bundleRef: BundleRef) {}

  async create(userEmail: string, name: string, seed: Seed): Promise<DeckRow> {
    const slug = slugify(name);
    const id = randomUUID();
    const appDir = join(this.cfg.localDecksRoot, id);
    // Read fresh per creation (not cached at construction time) so a bundle swapped
    // in via PUT /api/bundle after startup is reflected in the very next blank deck,
    // matching every other bundleRef.current() call site's freshness guarantee.
    const resolvedSeed: Seed = seed.kind === "blank"
      ? { ...seed, themeName: deriveThemeName(this.bundleRef.current().themeCss) }
      : seed;
    try {
      await seedDeck(appDir, slug, resolvedSeed);
      return this.store.create({ id, userEmail, name, slug, appId: "", sandboxId: "", kind: "local" });
    } catch (e: unknown) {
      rmSync(appDir, { recursive: true, force: true });
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    const row = this.store.get(id);
    if (row === null) return;
    rmSync(join(this.cfg.localDecksRoot, row.id), { recursive: true, force: true });
    this.store.delete(id);
  }
}
