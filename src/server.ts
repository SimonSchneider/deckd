import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { statSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Config } from "./config.js";
import type { BundleRef, BundleWriter } from "./bundle.js";
import { installBundleZip, bundleSummary } from "./bundle-upload.js";
import { zipBundleDir } from "./bundle-pack.js";
import { SessionStore, type SessionRow } from "./store.js";
import { SessionService } from "./sessions.js";
import { RenderQueue } from "./render.js";
import {
  listExampleDecks, deckPaths, exampleDeckPaths, saveAsset, exportZip, syncCanonicalDeckCache, SLUG_RE,
} from "./artifacts.js";

export interface Deps {
  // The write half (replace()) is only ever exercised by this file's PUT /api/bundle
  // route -- see bundle.ts's BundleRef/BundleWriter split for why mcp.ts and
  // host-render.ts each take the plain read-only BundleRef instead.
  cfg: Config; bundleRef: BundleRef & BundleWriter; store: SessionStore; sessions: SessionService; renders: RenderQueue;
  // A pre-built Express app to add routes to instead of creating a fresh one --
  // needed when mountMcp must register /mcp's own larger json() parser before this
  // function's global one mounts (see mcp.ts's mountMcp and index.ts).
  app?: Express;
}

function mtimeOf(p: string): number | null {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// body-parser sets a numeric .status on its errors (400 for a malformed body,
// 413 for one over the size limit); anything without one defaults to 400.
function errorStatus(err: unknown): number {
  const s = typeof err === "object" && err !== null ? (err as Record<string, unknown>).status : undefined;
  return typeof s === "number" ? s : 400;
}

// A stale SPA tab (or any client still pointed at the removed in-app chat) gets a
// clear, permanent signal here instead of a bare 404: chat now lives entirely over
// MCP, for a client to bring its own AI subscription to.
const CHAT_MOVED_ERROR = { error: "chat has moved to MCP (BYOAI); see README" };
function chatMoved(res: Response): void {
  res.status(410).json(CHAT_MOVED_ERROR);
}

export function buildApp(deps: Deps): Express {
  const { cfg, bundleRef, store, sessions, renders } = deps;
  const app = deps.app ?? express();
  // 2mb covers every JSON body this app accepts outside MCP (session names, deck
  // markdown). /mcp needs a much larger limit for base64-encoded asset uploads, so
  // it carries its own -- mounted by mountMcp on this same app before this call,
  // when deps.app is passed in (see index.ts, mcp.test.ts).
  app.use(express.json({ limit: "2mb" }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const h = req.header("x-deckd-user");
    (req as Request & { user: string }).user = h === undefined || h === "" ? cfg.devUser : h;
    next();
  });
  const userOf = (req: Request): string => (req as Request & { user: string }).user;

  // Every session this app serves is a "local" (plain-directory) session. A
  // pre-migration "sandbox" row can still exist in the DB (see store.ts's kind
  // column and index.ts's startup check); it is excluded from listings and, here,
  // treated as not found rather than served from a directory that doesn't exist.
  function ownedSession(req: Request, res: Response): SessionRow | null {
    // Always present at match time for a registered ":id" segment; the "?? ''" is
    // only to satisfy noUncheckedIndexedAccess on ParamsDictionary's index signature.
    const id = req.params.id ?? "";
    const row = store.get(id);
    if (row === null || row.userEmail !== userOf(req) || row.kind !== "local") {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return row;
  }
  const appDirOf = (row: SessionRow): string => join(cfg.localSessionsRoot, row.id);
  const renderKey = (sessionId: string, deck: string): string => `${sessionId}:${deck}`;
  const isOwnDeck = (row: SessionRow, deck: string): boolean => deck === row.slug;
  // A canonical (non-own) deck's render always targets the one shared cache copy
  // (syncCanonicalDeckCache), so every session rendering it must use the same queue
  // key too — otherwise two sessions previewing the same canonical deck would each
  // get their own key, and the queue's per-key single-flight/coalescing (its only
  // protection against concurrent renders stepping on the same directory) would
  // never engage between them.
  const canonicalRenderKey = (deck: string): string => `canonical:${deck}`;
  const renderKeyFor = (row: SessionRow, deck: string): string =>
    isOwnDeck(row, deck) ? renderKey(row.id, deck) : canonicalRenderKey(deck);

  // examplesDir is only absent for a bundle that declares no examples; every place
  // below reaching for it does so because allDecksFor/deckParam already established
  // the requested deck is a real, listed example, so it must be defined by then.
  const examplesDirOrThrow = (): string => {
    const examplesDir = bundleRef.current().examplesDir;
    if (examplesDir === undefined) throw new Error("no examples dir configured for this bundle");
    return examplesDir;
  };
  // Every example slug in the active bundle, or [] for a bundle with no examples
  // dir. Reads bundleRef fresh on every call, so a bundle swap is reflected
  // immediately. The single source of truth for "is this a real example" --
  // shared by allDecksFor (session-scoped browsing), GET /api/examples (the
  // sessionless list), and exampleSlugParam (sessionless validation) below.
  const currentExampleSlugs = (): string[] => {
    const examplesDir = bundleRef.current().examplesDir;
    return examplesDir === undefined ? [] : listExampleDecks(examplesDir);
  };
  // Every deck the session may browse: its own, plus every deck in the active
  // bundle's examples dir (read-only reference material, e.g. template-gallery).
  const allDecksFor = (row: SessionRow): string[] => {
    const canonical = currentExampleSlugs().filter((d) => d !== row.slug);
    return [row.slug, ...canonical];
  };
  // Where a deck's slides.md lives for reading: the session's own workspace for its
  // own deck, or straight from the bundle's examples dir (live, read-only) for a
  // canonical one — there is no need to cache a copy just to read source text.
  const sourcePathsFor = (row: SessionRow, deck: string) =>
    isOwnDeck(row, deck) ? deckPaths(appDirOf(row), deck) : exampleDeckPaths(examplesDirOrThrow(), deck);
  // Where a deck's render OUTPUT (pdf/pptx) lives: the session's own workspace for its
  // own deck, or the canonical cache copy for a non-own deck — a canonical deck is
  // never rendered with deckDir pointing into the bundle itself (see
  // syncCanonicalDeckCache), so its output never lands there either.
  const outputPathsFor = (row: SessionRow, deck: string) =>
    isOwnDeck(row, deck) ? deckPaths(appDirOf(row), deck) : deckPaths(cfg.canonicalCacheDir, deck);

  app.get("/api/me", (req, res) => {
    res.json({ email: userOf(req), sessions: store.listForUser(userOf(req)) });
  });

  app.post("/api/sessions", (req, res) => {
    const body: unknown = req.body;
    const name = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).name === "string"
      ? ((body as Record<string, unknown>).name as string) : "";
    if (name === "") { res.status(400).json({ error: "name required" }); return; }
    const seedMd = typeof (body as Record<string, unknown>).seedMd === "string"
      ? ((body as Record<string, unknown>).seedMd as string) : null;
    void sessions
      .create(userOf(req), name, seedMd === null ? { kind: "blank", title: name } : { kind: "md", content: seedMd })
      .then((row) => res.status(201).json(row))
      .catch((e: unknown) => res.status(502).json({ error: String(e) }));
  });

  // type-is's "*/*" glob still requires a Content-Type header to be present; a
  // matcher function bypasses that check so a header-less zip upload still binds.
  app.post("/api/sessions/import", express.raw({ type: () => true, limit: "100mb" }), (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (name === "" || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "name query param and zip body required" }); return;
    }
    const zipPath = join(mkdtempSync(join(tmpdir(), "deckd-import-")), "import.zip");
    writeFileSync(zipPath, req.body);
    void sessions
      .create(userOf(req), name, { kind: "zip", zipPath })
      .then((row) => res.status(201).json(row))
      .catch((e: unknown) => res.status(502).json({ error: String(e) }))
      .finally(() => rmSync(dirname(zipPath), { recursive: true, force: true }));
  });

  app.get("/api/sessions/:id", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const deck = deckParam(req, res, row);
    if (deck === null) return;
    const outP = outputPathsFor(row, deck);
    const srcP = sourcePathsFor(row, deck);
    store.touch(row.id);
    res.json({
      session: store.get(row.id),
      render: renders.status(renderKeyFor(row, deck)), decks: allDecksFor(row),
      pdfMtime: mtimeOf(outP.pdf), pptxMtime: mtimeOf(outP.pptx), sourceMtime: mtimeOf(srcP.slides),
    });
  });

  app.delete("/api/sessions/:id", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    void sessions.remove(row.id)
      .then(() => {
        renders.prune(`${row.id}:`);
        res.status(204).end();
      })
      .catch((e: unknown) => res.status(502).json({ error: String(e) }));
  });

  function deckParam(req: Request, res: Response, row: SessionRow): string | null {
    const deck = typeof req.query.deck === "string" && req.query.deck !== "" ? req.query.deck : row.slug;
    if (!SLUG_RE.test(deck)) { res.status(400).json({ error: "bad deck" }); return null; }
    if (!allDecksFor(row).includes(deck)) { res.status(404).json({ error: "unknown deck" }); return null; }
    return deck;
  }

  app.get("/api/sessions/:id/pdf", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const deck = deckParam(req, res, row);
    if (deck === null) return;
    const p = outputPathsFor(row, deck);
    if (!existsSync(p.pdf)) { res.status(404).json({ error: "not rendered yet" }); return; }
    if (req.query.download === "1") res.setHeader("content-disposition", `attachment; filename="${deck}.pdf"`);
    res.setHeader("cache-control", "no-store");
    res.type("application/pdf").sendFile(p.pdf);
  });

  app.get("/api/sessions/:id/pptx", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const deck = deckParam(req, res, row);
    if (deck === null) return;
    const p = outputPathsFor(row, deck);
    if (!existsSync(p.pptx)) { res.status(404).json({ error: "no pptx yet" }); return; }
    res.setHeader("content-disposition", `attachment; filename="${deck}-editable.pptx"`);
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation").sendFile(p.pptx);
  });

  app.get("/api/sessions/:id/source", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const deck = deckParam(req, res, row);
    if (deck === null) return;
    const p = sourcePathsFor(row, deck);
    let mtime: number;
    try { mtime = statSync(p.slides).mtimeMs; } catch { res.status(404).json({ error: "no slides.md" }); return; }
    res.json({ content: readFileSync(p.slides, "utf8"), mtime });
  });

  // Always the session's own deck — other decks are read-only reference material,
  // so there is no ?deck= param here (contrast deckParam-based routes above).
  app.put("/api/sessions/:id/source", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const body: unknown = req.body;
    const content = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).content === "string"
      ? ((body as Record<string, unknown>).content as string) : null;
    const baseMtime = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).baseMtime === "number"
      ? ((body as Record<string, unknown>).baseMtime as number) : null;
    if (content === null || baseMtime === null) { res.status(400).json({ error: "content and baseMtime required" }); return; }
    const p = deckPaths(appDirOf(row), row.slug);
    const current = mtimeOf(p.slides) ?? 0;
    // >1ms tolerance absorbs filesystem mtime rounding, not concurrent edits.
    if (Math.abs(current - baseMtime) > 1) {
      res.status(409).json({ error: "modified on disk", mtime: current, content: existsSync(p.slides) ? readFileSync(p.slides, "utf8") : "" });
      return;
    }
    writeFileSync(p.slides, content);
    renders.enqueue({ key: renderKey(row.id, row.slug), slug: row.slug, deckDir: p.dir, pptx: false });
    res.json({ mtime: statSync(p.slides).mtimeMs });
  });

  // Chat lived entirely in the in-app agent, which this app no longer has: every
  // chat-shaped route now 410s instead of doing anything, so a stale client gets a
  // clear, permanent signal to switch to MCP rather than a silent 404.
  app.post("/api/sessions/:id/chat", (req, res) => {
    if (ownedSession(req, res) === null) return;
    chatMoved(res);
  });
  app.post("/api/sessions/:id/chat/cancel", (req, res) => {
    if (ownedSession(req, res) === null) return;
    chatMoved(res);
  });
  app.get("/api/sessions/:id/chat/history", (req, res) => {
    if (ownedSession(req, res) === null) return;
    chatMoved(res);
  });
  app.get("/api/sessions/:id/events", (req, res) => {
    if (ownedSession(req, res) === null) return;
    chatMoved(res);
  });

  app.post("/api/sessions/:id/render", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const deck = deckParam(req, res, row);
    if (deck === null) return;
    // A non-own deck is always rendered from a fresh cache copy, never from the
    // bundle itself — the host renderer copies its output back into deckDir, and
    // that must never land inside uploaded, shared content.
    const deckDir = isOwnDeck(row, deck)
      ? deckPaths(appDirOf(row), deck).dir
      : syncCanonicalDeckCache(examplesDirOrThrow(), cfg.canonicalCacheDir, deck);
    renders.enqueue({ key: renderKeyFor(row, deck), slug: deck, deckDir, pptx: req.query.pptx === "1" });
    res.status(202).json({ queued: deck });
  });

  // type-is's "*/*" glob still requires a Content-Type header to be present; a
  // matcher function bypasses that check so a header-less image upload still binds.
  app.post("/api/sessions/:id/assets", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (name === "" || !Buffer.isBuffer(req.body)) { res.status(400).json({ error: "name + body required" }); return; }
    try {
      res.status(201).json({ path: saveAsset(appDirOf(row), row.slug, name, req.body) });
    } catch (e: unknown) { res.status(400).json({ error: String(e) }); }
  });

  app.get("/api/sessions/:id/export", (req, res) => {
    const row = ownedSession(req, res);
    if (row === null) return;
    const out = join(mkdtempSync(join(tmpdir(), "deckd-export-")), `${row.slug}.zip`);
    void exportZip(appDirOf(row), row.slug, out)
      .then(() => {
        res.setHeader("content-disposition", `attachment; filename="${row.slug}.zip"`);
        res.sendFile(out, () => rmSync(dirname(out), { recursive: true, force: true }));
      })
      .catch((e: unknown) => res.status(502).json({ error: String(e) }));
  });

  // Sessionless viewing of a bundle example: the canonical-cache machinery
  // (syncCanonicalDeckCache, canonicalRenderKey, exampleDeckPaths/deckPaths) is
  // already session-independent -- these routes are thin wrappers around exactly
  // what the session ?deck= routes above use for a non-own deck, so an example
  // stays viewable with no session selected (see also allDecksFor/deckParam,
  // which keep working unchanged for MCP/check_deck and the old session-scoped
  // ?deck= flow).
  function exampleSlugParam(req: Request, res: Response): string | null {
    const slug = req.params.slug ?? "";
    if (!SLUG_RE.test(slug)) { res.status(400).json({ error: "bad example" }); return null; }
    if (!currentExampleSlugs().includes(slug)) { res.status(404).json({ error: "unknown example" }); return null; }
    return slug;
  }

  app.get("/api/examples", (_req, res) => {
    res.json({ examples: currentExampleSlugs() });
  });

  app.get("/api/examples/:slug", (req, res) => {
    const slug = exampleSlugParam(req, res);
    if (slug === null) return;
    const outP = deckPaths(cfg.canonicalCacheDir, slug);
    const srcP = exampleDeckPaths(examplesDirOrThrow(), slug);
    res.json({
      render: renders.status(canonicalRenderKey(slug)),
      pdfMtime: mtimeOf(outP.pdf), pptxMtime: mtimeOf(outP.pptx), sourceMtime: mtimeOf(srcP.slides),
    });
  });

  app.get("/api/examples/:slug/source", (req, res) => {
    const slug = exampleSlugParam(req, res);
    if (slug === null) return;
    const p = exampleDeckPaths(examplesDirOrThrow(), slug);
    let mtime: number;
    try { mtime = statSync(p.slides).mtimeMs; } catch { res.status(404).json({ error: "no slides.md" }); return; }
    res.json({ content: readFileSync(p.slides, "utf8"), mtime });
  });

  app.post("/api/examples/:slug/render", (req, res) => {
    const slug = exampleSlugParam(req, res);
    if (slug === null) return;
    const deckDir = syncCanonicalDeckCache(examplesDirOrThrow(), cfg.canonicalCacheDir, slug);
    renders.enqueue({ key: canonicalRenderKey(slug), slug, deckDir, pptx: req.query.pptx === "1" });
    res.status(202).json({ queued: slug });
  });

  app.get("/api/examples/:slug/pdf", (req, res) => {
    const slug = exampleSlugParam(req, res);
    if (slug === null) return;
    const p = deckPaths(cfg.canonicalCacheDir, slug);
    if (!existsSync(p.pdf)) { res.status(404).json({ error: "not rendered yet" }); return; }
    if (req.query.download === "1") res.setHeader("content-disposition", `attachment; filename="${slug}.pdf"`);
    res.setHeader("cache-control", "no-store");
    res.type("application/pdf").sendFile(p.pdf);
  });

  app.get("/api/bundle", (_req, res) => {
    res.json(bundleSummary(bundleRef.current()));
  });

  app.get("/api/bundle/download", (_req, res) => {
    const outDir = mkdtempSync(join(tmpdir(), "deckd-bundle-download-"));
    const outPath = join(outDir, "deckd-bundle.zip");
    void zipBundleDir(bundleRef.current().dir, outPath)
      .then(() => {
        res.setHeader("content-disposition", 'attachment; filename="deckd-bundle.zip"');
        res.type("application/zip").sendFile(outPath, () => rmSync(outDir, { recursive: true, force: true }));
      })
      .catch((e: unknown) => res.status(502).json({ error: errorMessage(e) }));
  });

  // type-is's "*/*" glob still requires a Content-Type header to be present; a
  // matcher function bypasses that check so a header-less zip upload still binds
  // (same pattern as /api/sessions/import above). 100mb matches spec decision 3's
  // "dedicated size limit ~100MB" for a bundle upload; installBundleZip enforces its
  // own, separate decoded-size cap on top of this compressed-body one.
  app.put("/api/bundle", express.raw({ type: () => true, limit: "100mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "zip body required" });
      return;
    }
    void installBundleZip(req.body, cfg, bundleRef, (m) => console.log(m))
      .then(({ summary }) => res.status(200).json(summary))
      .catch((e: unknown) => res.status(400).json({ error: errorMessage(e) }));
  });

  app.get("/admin.html", (_req, res) => { res.sendFile(join(process.cwd(), "public", "admin.html")); });

  // Lets the MCP connect popover link straight to the setup section instead of
  // just naming the file; served as plain text since there is no markdown renderer
  // here, so a #fragment does not scroll to the heading, but the file still opens.
  app.get("/README.md", (_req, res) => { res.type("text/plain").sendFile(join(process.cwd(), "README.md")); });

  app.get("/", (_req, res) => { res.sendFile(join(process.cwd(), "public", "index.html")); });

  // Only body-parser (express.json/express.raw) calls next(err) in this app; every
  // route above handles its own errors and responds directly. Without this, a
  // malformed body would fall through to Express's default HTML error page instead
  // of the {error} JSON shape every other endpoint uses.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    res.status(errorStatus(err)).json({ error: errorMessage(err) });
  });

  return app;
}
