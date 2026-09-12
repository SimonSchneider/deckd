import express from "express";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadBundle, createBundleRef } from "./bundle.js";
import { DeckStore, assertDbPathNotAbandoningLegacy } from "./store.js";
import { DeckService, migrateLegacyDecksRoot } from "./decks.js";
import { RenderQueue, createRenderRunner } from "./render.js";
import { createHostRenderer } from "./host-render.js";
import { buildApp } from "./server.js";
import { mountMcp } from "./mcp.js";
import { mountMcpAdmin } from "./mcp-admin.js";

const cfg = loadConfig(process.env);
// Loaded once at startup and wrapped in a BundleRef: server.ts/mcp.ts/host-render.ts
// each read it fresh via bundleRef.current() rather than closing over the Bundle
// value, so PUT /api/bundle (server.ts) can swap it live -- see bundle.ts's
// createBundleRef. Seed cfg.bundleDir by hand before starting, if it's empty --
// e.g. by copying examples/starter-bundle, or extracting a zip built with
// `deckd pack`.
const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));
// See store.ts's assertDbPathNotAbandoningLegacy: a pre-pivot deployment's db lived
// at this cwd-relative default before dbPath moved under DECKD_DATA_DIR.
assertDbPathNotAbandoningLegacy(cfg.dbPath, join(process.cwd(), "deckd.sqlite3"));
const store = new DeckStore(cfg.dbPath);

// A "sandbox"-kind row is a pre-migration leftover from before the bundle pivot
// removed sandboxd: this app has nowhere to render it from (no sandbox, no
// sandboxd-backed workspace), so it is never served -- listForUser already
// excludes it from listings; this just makes the gap loud instead of silent.
const legacySandboxDecks = store.listSandboxDecks();
if (legacySandboxDecks.length > 0) {
  console.error(
    `deckd: ${legacySandboxDecks.length} legacy sandbox deck(s) will NOT be served: ` +
      `${legacySandboxDecks.map((r) => r.id).join(", ")}. ` +
      "There is no migration path for these -- export any content you need from their old workspace by hand.",
  );
}

// See decks.ts's migrateLegacyDecksRoot: the decks root was "local-sessions" before
// the deck rename.
migrateLegacyDecksRoot(cfg.localDecksRoot);
const decks = new DeckService(store, cfg, bundleRef);
// The composition root is the one place allowed to read process.env: the host
// renderer's child processes (marp, node for gen-pptx) need a real PATH/HOME to
// resolve their own dependencies, which no other module reaches into process.env for.
const hostRenderer = createHostRenderer({
  bundleRef,
  scratchRoot: cfg.scratchDir,
  log: (m) => console.log(m),
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  chromePath: cfg.chromePath,
});
const renders = new RenderQueue(createRenderRunner(hostRenderer), 2);
const app = express();
// Local trial only: no auth, MCP tools act as cfg.devUser; safe only because the
// server binds 127.0.0.1 (below), matching the rest of this service today. Mounted
// before buildApp below so /mcp's own larger json() limit is registered ahead of
// buildApp's global one (see mcp.ts's mountMcp).
mountMcp(app, { cfg, bundleRef, decks, store, renders, hostRenderer });
// Separate admin endpoint for bundle management (see mcp-admin.ts): /mcp (above) has
// no bundle tools at all, so a deck-editing AI client cannot touch the live bundle.
mountMcpAdmin(app, { cfg, bundleRef });
buildApp({ cfg, bundleRef, store, decks, renders, app });
app.listen(cfg.port, "127.0.0.1", () => {
  console.log(`deckd on http://127.0.0.1:${cfg.port}`);
  console.log(`MCP endpoint on http://127.0.0.1:${cfg.port}/mcp`);
  console.log(`Admin MCP endpoint (bundle management, no auth) on http://127.0.0.1:${cfg.port}/mcp-admin`);
});
