import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, type SessionRow } from "./store.js";
import { seedDeck, slugify, deriveThemeName, type Seed } from "./artifacts.js";
import type { Config } from "./config.js";
import type { BundleRef } from "./bundle.js";

// A session is a plain directory: no sandboxd app, no container, no toolkit
// copies, no CLAUDE.md (an external AI gets its guidance from the MCP tools
// instead). Rendering is host-only (see render.ts), so there is nothing here to
// slim, restart, or wait on.
export class SessionService {
  constructor(private store: SessionStore, private cfg: Config, private bundleRef: BundleRef) {}

  async create(userEmail: string, name: string, seed: Seed): Promise<SessionRow> {
    const slug = slugify(name);
    const id = randomUUID();
    const appDir = join(this.cfg.localSessionsRoot, id);
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
    rmSync(join(this.cfg.localSessionsRoot, row.id), { recursive: true, force: true });
    this.store.delete(id);
  }
}
