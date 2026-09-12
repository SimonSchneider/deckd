import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { Bundle, BundleRef } from "./bundle.js";
import { DeckStore, type DeckRow } from "./store.js";
import { DeckService } from "./decks.js";
import { RenderQueue, type RenderResult } from "./render.js";
import { formatLayoutReport } from "./host-render.js";
import type { HostRenderer, HostPreviewResult, HostCheckLayoutResult, LayoutIssue } from "./host-render.js";
import { deckPaths, exampleDeckPaths, listExampleDecks, saveAssetAt, syncCanonicalDeckCache, SLUG_RE, type Seed } from "./artifacts.js";
import { MARP_SYNTAX_REFERENCE } from "./marp-syntax-reference.js";

export interface McpDeps {
  cfg: Config;
  bundleRef: BundleRef;
  decks: DeckService;
  store: DeckStore;
  renders: RenderQueue;
  hostRenderer: HostRenderer;
}

const SERVER_NAME = "deckd";
const SERVER_VERSION = "1.0.0";

const SERVER_INSTRUCTIONS = [
  "deckd builds Marp markdown decks. Call read_guide first for the full authoring guide",
  "-- it also includes a built-in Marp/Marpit syntax reference, so there's no need to look that up elsewhere.",
  "Then create_deck (or list_decks to pick an existing one) to get a deck to work on.",
  "Edit it with write_slides: it saves the markdown and renders, returning any render error",
  "in the response -- keep iterating write_slides until render_code is 0.",
  "Upload any image or SVG chart you generate yourself with upload_asset, into images/ or",
  "charts/, and reference it from the markdown with the relative path upload_asset returns.",
  "Use get_slide_previews to see rendered slide screenshots and check_deck to catch slide-layout",
  "overflow, to check your work visually and structurally before calling a deck done. list_examples",
  "and get_deck can read canonical example decks for style reference.",
].join(" ");

const GUIDE_PREFACE = [
  "deckd is a local deck-building service. A deck is a Marp markdown presentation at",
  "presentations/<slug>/slides.md inside that deck's own directory. Images live under images/,",
  "generated charts (SVG preferred) under charts/. preview/ is reserved for deckd's own",
  "rendered slide screenshots -- never write deck content there.",
  "",
  "The authoring guide below (the bundle's own guide) is the full reference for writing a",
  "deck: theme conventions, layout classes, chart style, and anything else specific to this",
  "toolkit.",
].join("\n");

// 10MB decoded, independent of saveAsset's 20MB HTTP-upload cap: MCP tool calls are a
// single JSON-RPC request body, which is already bounded much lower than the raw HTTP
// asset route, so a distinct, tighter limit is a deliberate choice, not an oversight.
const MAX_MCP_ASSET_BYTES = 10 * 1024 * 1024;

// A write_slides render is a synchronous round trip the caller is actively waiting on,
// so it needs its own generous-but-finite bound distinct from the render queue's other
// timeouts; 180s matches the host renderer's own DEFAULT_TIMEOUT_MS.
const WRITE_RENDER_TIMEOUT_MS = 180_000;

// Default page count for get_slide_previews when the caller doesn't specify `pages`.
const DEFAULT_PREVIEW_PAGES = 12;

// Parameter docs shared by every tool that takes a deck reference, so an MCP client's
// model sees the same wording everywhere: deck_id is the `deck_id` from list_decks /
// create_deck (a UUID), never the slug; example is a name from list_examples.
//
// Nothing in deckd is called a "session" any more, and the MCP parameter is deck_id,
// not session_id, for a concrete reason: at least one MCP proxy (Anthropic's
// remote-devices aggregator, as seen from the Claude app) reserves a `session_id`
// argument for its own routing and strips it before the call reaches this server, so
// a parameter by that name silently never arrives.
const DECK_ID_DOC = "Deck id (UUID) as returned in `deck_id` by list_decks or create_deck. Not the slug.";
const EXAMPLE_DOC = "Name of a read-only example deck from list_examples. Use instead of deck_id, never both.";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function jsonErrorResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: true };
}

// Every tool handler is wrapped with this instead of letting exceptions reach the SDK:
// a thrown error there becomes a JSON-RPC protocol-level error, which most MCP clients
// surface far less usefully to the calling AI than a normal tool result with isError.
function wrap<Args extends unknown[]>(
  fn: (...args: Args) => Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (e: unknown) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  };
}

// Every deck a deck resolves to lives under this exact path, matching server.ts's
// appDirOf for the "local" branch: <localDecksRoot>/<deckId>/.
function localAppDir(cfg: Config, row: DeckRow): string {
  return join(cfg.localDecksRoot, row.id);
}

function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// Every deck is "local" now; a "sandbox" row can only be a pre-migration
// leftover the app never serves (see store.ts's kind column and index.ts's
// startup check), so reaching that branch here means the caller passed a
// deck_id from before that migration, not a runtime condition to route around.
function resolveLocalDeck(store: DeckStore, cfg: Config, deckId: string): DeckRow {
  const row = store.get(deckId);
  if (row === null || row.userEmail !== cfg.devUser) throw new Error(`no such deck: ${deckId}`);
  if (row.kind !== "local") {
    throw new Error(`deck ${deckId} has not been migrated to a local deck (kind: ${row.kind})`);
  }
  return row;
}

type DeckRef = { kind: "deck"; deckId: string } | { kind: "example"; example: string };

function resolveDeckRef(deckId: string | undefined, example: string | undefined): DeckRef {
  if (deckId !== undefined && example === undefined) return { kind: "deck", deckId };
  if (example !== undefined && deckId === undefined) return { kind: "example", example };
  throw new Error("exactly one of deck_id (from list_decks or create_deck) or example is required");
}

function resolveExampleDeckDir(bundle: Bundle, example: string): string {
  if (bundle.examplesDir === undefined || !listExampleDecks(bundle.examplesDir).includes(example)) {
    throw new Error(`unknown example deck: ${example}`);
  }
  return exampleDeckPaths(bundle.examplesDir, example).dir;
}

// Where to read a deck's slides.md/assets from: the deck's own workspace for a
// local deck, or straight from the bundle's examples dir (read-only) for an example.
function resolveReadLocation(deps: McpDeps, ref: DeckRef): { slug: string; deckDir: string } {
  if (ref.kind === "example") return { slug: ref.example, deckDir: resolveExampleDeckDir(deps.bundleRef.current(), ref.example) };
  const row = resolveLocalDeck(deps.store, deps.cfg, ref.deckId);
  return { slug: row.slug, deckDir: deckPaths(localAppDir(deps.cfg, row), row.slug).dir };
}

// Where to render a deck's slide previews from, and the render-queue key to coalesce
// on: the deck's own directory keyed like a pdf render's own-deck key, or a
// fresh canonical cache copy keyed like a pdf render's canonical key (see
// server.ts's renderKey/canonicalRenderKey) -- an example is never rendered with
// deckDir pointing into the bundle itself, since the host renderer copies its
// output back into deckDir.
//
// deckDir is a thunk, not a resolved string: for an example deck, resolving it means
// actually re-syncing the canonical cache from the bundle's examples dir
// (syncCanonicalDeckCache), which is real filesystem work. Deferring it lets
// makeCoalescer below call it only once the coalescer has decided this call is the
// one actually doing the render, so two concurrent requests for the same example
// share one cache re-sync instead of each running (and racing) their own.
function resolvePreviewLocation(deps: McpDeps, ref: DeckRef): { slug: string; deckDir: () => string; key: string } {
  if (ref.kind === "example") {
    return {
      slug: ref.example,
      deckDir: () => {
        const examplesDir = deps.bundleRef.current().examplesDir;
        if (examplesDir === undefined) throw new Error(`unknown example deck: ${ref.example}`);
        return syncCanonicalDeckCache(examplesDir, deps.cfg.canonicalCacheDir, ref.example);
      },
      key: `canonical:${ref.example}`,
    };
  }
  const row = resolveLocalDeck(deps.store, deps.cfg, ref.deckId);
  return { slug: row.slug, deckDir: () => deckPaths(localAppDir(deps.cfg, row), row.slug).dir, key: `${row.id}:${row.slug}` };
}

interface AssetInfo {
  path: string;
  size: number;
}

// Recursively lists every file under deckDir except slides.md itself and the top-level
// preview/ directory (deckd's own generated screenshots, not deck content -- see
// isExcludedDeckEntry's identical reasoning in artifacts.ts). Symlinks are skipped
// rather than followed, matching every other deck-content walk in this codebase.
function listAssets(deckDir: string): AssetInfo[] {
  const out: AssetInfo[] = [];
  function walk(dir: string, relBase: string): void {
    for (const entry of readdirSync(dir)) {
      if (relBase === "" && (entry === "slides.md" || entry.toLowerCase() === "preview")) continue;
      const abs = join(dir, entry);
      const rel = relBase === "" ? entry : `${relBase}/${entry}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      out.push({ path: rel, size: st.size });
    }
  }
  if (existsSync(deckDir)) walk(deckDir, "");
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Polls the render queue's status for `key` until it's neither rendering nor queued.
// enqueue() synchronously moves the job into one of those two states before returning
// (see render.ts's pump()), so the first poll after enqueuing never races an
// about-to-start job -- by the time both flags are false, the queue's single-flight
// guarantee for this key means the settled `last` result is the job just enqueued.
async function awaitRenderSettle(renders: RenderQueue, key: string, timeoutMs: number): Promise<RenderResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = renders.status(key);
    if (!st.rendering && !st.queued) {
      if (st.last === null) throw new Error("render queue produced no result");
      return st.last;
    }
    if (Date.now() >= deadline) throw new Error(`render did not finish within ${timeoutMs}ms`);
    await sleep(50);
  }
}

// Coalesces concurrent requests for the same deck into one host-render call: two
// calls for the same key while one is in flight share its result instead of racing
// each other's host-renderer scratch directory. Keyed exactly like a pdf render's
// own-deck/canonical key (see server.ts's renderKey/canonicalRenderKey), for the same
// reason documented there -- two callers acting on the same canonical deck must land
// on the same key to ever coalesce at all. Shared by previews and layout checks,
// which both key and coalesce identically; only which host-renderer method they call
// differs.
//
// deckDir is a thunk (see resolvePreviewLocation) invoked here, inside the coalesced
// section, rather than by the caller before it ever reaches this function: that's what
// makes it run at most once per in-flight key, so an example deck's canonical-cache
// re-sync happens once even when two requests for it land concurrently, instead of
// once per caller before either one even joins the coalescer.
function makeCoalescer<T>(
  run: (key: string, deckDir: string, slug: string) => Promise<T>,
): (key: string, deckDir: () => string, slug: string) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key, deckDir, slug) => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const p = run(key, deckDir(), slug).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

type PreviewOnceFn = (key: string, deckDir: () => string, slug: string) => Promise<HostPreviewResult>;
type CheckLayoutOnceFn = (key: string, deckDir: () => string, slug: string) => Promise<HostCheckLayoutResult>;

function makePreviewOnce(hostRenderer: HostRenderer): PreviewOnceFn {
  return makeCoalescer((key, deckDir, slug) => hostRenderer.renderPreviews({ key, deckDir, slug }));
}

function makeCheckLayoutOnce(hostRenderer: HostRenderer): CheckLayoutOnceFn {
  return makeCoalescer((key, deckDir, slug) => hostRenderer.checkLayout({ key, deckDir, slug }));
}

function registerTools(server: McpServer, deps: McpDeps, previewOnce: PreviewOnceFn, checkLayoutOnce: CheckLayoutOnceFn): void {
  server.registerTool(
    "read_guide",
    { description: "Read the deckd authoring guide. Call this first, before creating or editing any deck." },
    wrap(async () => {
      const guidePath = deps.bundleRef.current().guidePath;
      const guide =
        guidePath === undefined
          ? "(this bundle declares no guide -- no authoring guide available)"
          : readFileSync(guidePath, "utf8");
      return textResult(`${GUIDE_PREFACE}\n\n---\n\n${guide}\n\n---\n\n${MARP_SYNTAX_REFERENCE}`);
    }),
  );

  server.registerTool(
    "list_decks",
    {
      description:
        "List your local decks. Each entry's `deck_id` is what get_deck, write_slides, upload_asset, " +
        "get_slide_previews, check_deck and export_deck take; `slug` is only the deck's folder name.",
    },
    wrap(async () => {
      // listForUser already excludes any legacy "sandbox"-kind row (see store.ts).
      const rows = deps.store.listForUser(deps.cfg.devUser);
      return jsonResult(rows.map((r) => ({ deck_id: r.id, slug: r.slug, createdAt: r.createdAt, updatedAt: r.touchedAt })));
    }),
  );

  server.registerTool(
    "create_deck",
    {
      description:
        "Create a new local deck. Optionally seed it with markdown. " +
        "Returns { deck_id, slug }; keep `deck_id` -- every other deck tool takes it.",
      inputSchema: {
        slug: z.string().describe("Deck slug: lowercase letters, digits, hyphens, max 40 chars."),
        markdown: z.string().optional().describe("Initial slides.md content; a blank title slide if omitted."),
      },
    },
    wrap(async ({ slug, markdown }) => {
      if (!SLUG_RE.test(slug)) {
        throw new Error(`invalid slug "${slug}": must match ${SLUG_RE.source} (lowercase letters/digits/hyphens, max 40 chars)`);
      }
      const seed: Seed = markdown === undefined ? { kind: "blank", title: slug } : { kind: "md", content: markdown };
      const row = await deps.decks.create(deps.cfg.devUser, slug, seed);
      return jsonResult({ deck_id: row.id, slug: row.slug });
    }),
  );

  server.registerTool(
    "list_examples",
    { description: "List canonical example decks available for style reference." },
    wrap(async () => {
      const examplesDir = deps.bundleRef.current().examplesDir;
      return jsonResult(examplesDir === undefined ? [] : listExampleDecks(examplesDir));
    }),
  );

  server.registerTool(
    "get_deck",
    {
      description:
        "Read a deck's slides.md, mtime, and asset listing. Pass exactly one of deck_id (your own deck) " +
        "or example (a canonical deck, read-only).",
      inputSchema: {
        deck_id: z.string().optional().describe(DECK_ID_DOC),
        example: z.string().optional().describe(EXAMPLE_DOC),
      },
    },
    wrap(async ({ deck_id, example }) => {
      const { slug, deckDir } = resolveReadLocation(deps, resolveDeckRef(deck_id, example));
      const slidesPath = join(deckDir, "slides.md");
      if (!existsSync(slidesPath)) throw new Error(`deck has no slides.md: ${slug}`);
      return jsonResult({
        slug,
        markdown: readFileSync(slidesPath, "utf8"),
        mtime: statSync(slidesPath).mtimeMs,
        assets: listAssets(deckDir),
      });
    }),
  );

  server.registerTool(
    "write_slides",
    {
      description:
        "Save markdown for one of your local decks and render it. Returns render_code/render_output -- " +
        "keep iterating until render_code is 0. base_mtime must be the mtime last read from get_deck or a " +
        "prior write_slides call; a stale base_mtime returns the current on-disk content and mtime to merge from.",
      inputSchema: {
        deck_id: z.string().describe(DECK_ID_DOC),
        markdown: z.string(),
        base_mtime: z.number().describe("mtime (ms) this edit is based on, for the conflict check."),
      },
    },
    wrap(async ({ deck_id, markdown, base_mtime }) => {
      const row = resolveLocalDeck(deps.store, deps.cfg, deck_id);
      const p = deckPaths(localAppDir(deps.cfg, row), row.slug);
      const current = mtimeOf(p.slides) ?? 0;
      // >1ms tolerance absorbs filesystem mtime rounding, matching the HTTP source route.
      if (Math.abs(current - base_mtime) > 1) {
        return jsonErrorResult({
          error: "modified on disk",
          mtime: current,
          content: existsSync(p.slides) ? readFileSync(p.slides, "utf8") : "",
        });
      }
      writeFileSync(p.slides, markdown);
      const key = `${row.id}:${row.slug}`;
      deps.renders.enqueue({ key, slug: row.slug, deckDir: p.dir, pptx: false });
      const result = await awaitRenderSettle(deps.renders, key, WRITE_RENDER_TIMEOUT_MS);

      const response: {
        mtime: number;
        render_code: number;
        render_output: string;
        layout_issues?: LayoutIssue[];
        layout_check_note?: string;
      } = { mtime: statSync(p.slides).mtimeMs, render_code: result.code, render_output: result.output };

      // A layout check only makes sense against a deck that actually rendered; its
      // own failure must never fail the save that already succeeded, so it's reduced
      // to a note rather than surfaced as a tool error.
      if (result.code === 0) {
        try {
          const layout = await checkLayoutOnce(key, () => p.dir, row.slug);
          if (layout.code === 0) response.layout_issues = layout.issues;
          else response.layout_check_note = `layout check failed (exit ${layout.code}): ${layout.output}`.slice(0, 2000);
        } catch (e: unknown) {
          response.layout_check_note = `layout check failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return jsonResult(response);
    }),
  );

  server.registerTool(
    "upload_asset",
    {
      description:
        "Upload an image or SVG you generated to one of your local decks, under images/ or charts/. " +
        "Returns the relative path to reference from slides.md.",
      inputSchema: {
        deck_id: z.string().describe(DECK_ID_DOC),
        path: z.string().describe('Relative path within the deck, e.g. "images/logo.png" or "charts/plot.svg".'),
        data_base64: z.string().describe("Base64-encoded file contents, max 10MB decoded."),
      },
    },
    wrap(async ({ deck_id, path, data_base64 }) => {
      const row = resolveLocalDeck(deps.store, deps.cfg, deck_id);
      // Base64 runs ~4/3 the size of the bytes it decodes to, so a payload already
      // over the cap can be rejected from its encoded length alone -- without
      // paying for a Buffer.from decode of a string that can be tens of MB. The
      // decoded-byte check inside saveAssetAt still runs and remains authoritative,
      // since padding/whitespace make this an approximation.
      const approxBytes = (data_base64.length * 3) / 4;
      if (approxBytes > MAX_MCP_ASSET_BYTES) {
        throw new Error(`asset too large: ~${Math.round(approxBytes)} bytes (max ${MAX_MCP_ASSET_BYTES})`);
      }
      const data = Buffer.from(data_base64, "base64");
      const rel = saveAssetAt(localAppDir(deps.cfg, row), row.slug, path, data, MAX_MCP_ASSET_BYTES);
      return jsonResult({ path: rel });
    }),
  );

  server.registerTool(
    "get_slide_previews",
    {
      description:
        "Render and return slide screenshots as images, to check your work visually. Pass exactly one of " +
        "deck_id or example. Defaults to the first 12 pages; pass `pages` (1-indexed) to pick others.",
      inputSchema: {
        deck_id: z.string().optional().describe(DECK_ID_DOC),
        example: z.string().optional().describe(EXAMPLE_DOC),
        pages: z.array(z.number().int().positive()).max(40).optional(),
      },
    },
    wrap(async ({ deck_id, example, pages }) => {
      const { slug, deckDir, key } = resolvePreviewLocation(deps, resolveDeckRef(deck_id, example));
      const result = await previewOnce(key, deckDir, slug);
      if (result.code !== 0) return errorResult(`preview render failed (exit ${result.code}):\n${result.output}`);
      if (result.pngs.length === 0) return textResult("no slides rendered: the deck produced zero pages");

      const indexed = result.pngs.map((path, i) => ({ page: i + 1, path }));
      const selected =
        pages !== undefined && pages.length > 0
          ? indexed.filter((e) => pages.includes(e.page))
          : indexed.slice(0, DEFAULT_PREVIEW_PAGES);
      if (selected.length === 0) return textResult(`no matching pages among ${indexed.length} rendered`);

      const scale = deps.bundleRef.current().render.imageScale;
      const content: CallToolResult["content"] = [
        {
          type: "text",
          text: `Returned pages: ${selected.map((e) => e.page).join(", ")} (of ${indexed.length} total) at image scale ${scale}`,
        },
        ...selected.map((e) => ({
          type: "image" as const,
          data: readFileSync(e.path).toString("base64"),
          mimeType: "image/png",
        })),
      ];
      return { content };
    }),
  );

  server.registerTool(
    "check_deck",
    {
      description:
        "Check a deck for slide-layout issues: content that overflows the fixed slide box and gets clipped. " +
        "Pass exactly one of deck_id or example. Returns a readable report plus a structured issues array " +
        "(empty means the deck is clean).",
      inputSchema: {
        deck_id: z.string().optional().describe(DECK_ID_DOC),
        example: z.string().optional().describe(EXAMPLE_DOC),
      },
    },
    wrap(async ({ deck_id, example }) => {
      const { slug, deckDir, key } = resolvePreviewLocation(deps, resolveDeckRef(deck_id, example));
      const result = await checkLayoutOnce(key, deckDir, slug);
      if (result.code !== 0) return errorResult(`layout check failed (exit ${result.code}):\n${result.output}`);
      return jsonResult({ report: formatLayoutReport(result.issues), issues: result.issues });
    }),
  );

  server.registerTool(
    "export_deck",
    { description: "Get the download URL for a zip export of one of your local decks.", inputSchema: { deck_id: z.string().describe(DECK_ID_DOC) } },
    wrap(async ({ deck_id }) => {
      const row = resolveLocalDeck(deps.store, deps.cfg, deck_id);
      const url = `http://127.0.0.1:${deps.cfg.port}/api/decks/${row.id}/export`;
      return textResult(
        `${url}\n` +
          `Zip contains presentations/${row.slug}/ (slides.md and its assets: images/, charts/, ...), excluding the generated preview/ directory.`,
      );
    }),
  );
}

function methodNotAllowed(res: Response): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
  );
}

// Mounts the MCP endpoint on the given app at POST/GET/DELETE /mcp. Uses
// StreamableHTTPServerTransport in stateless mode (sessionIdGenerator: undefined): a
// fresh McpServer + transport per request, matching the SDK's own stateless example --
// there is no cross-request MCP session state to manage, which is the right shape for
// this local, single (dev) user, no-auth trial. GET and DELETE have nothing to do in
// stateless mode (no session to resume or terminate), so they 405 like the SDK example.
function logToolCall(body: unknown): void {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (typeof m !== "object" || m === null) continue;
    const { method, params } = m as { method?: unknown; params?: unknown };
    if (method !== "tools/call" || typeof params !== "object" || params === null) continue;
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    const shown =
      typeof args === "object" && args !== null
        ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 80 ? `<${v.length} chars>` : v]))
        : args;
    console.log(`[mcp] tools/call ${String(name)} params=${JSON.stringify({ ...(params as object), arguments: shown }).slice(0, 600)}`);
  }
}

export function mountMcp(app: Express, deps: McpDeps): void {
  const previewOnce = makePreviewOnce(deps.hostRenderer);
  const checkLayoutOnce = makeCheckLayoutOnce(deps.hostRenderer);

  // Scoped to /mcp and registered before the app's global json() parser mounts
  // (see server.ts's buildApp, which takes this same `app` afterwards): an
  // upload_asset call can carry a base64-encoded 10MB asset (base64 runs ~4/3 the
  // decoded size), well above the app's global 2mb limit, so /mcp needs its own
  // larger one. Express applies body parsers in registration order for every
  // matching path, so a path-scoped override only takes effect ahead of a
  // catch-all one if it is mounted first.
  app.use("/mcp", express.json({ limit: "20mb" }));

  function getServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, deps, previewOnce, checkLayoutOnce);
    return server;
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    // DECKD_DEBUG_MCP=1 logs each tools/call as it arrives (tool name + argument
    // keys, never values) -- the one place to see what an MCP client actually sent
    // when a tool reports a missing argument.
    if (process.env.DECKD_DEBUG_MCP) logToolCall(req.body);
    const server = getServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: unknown) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e instanceof Error ? e.message : String(e) }, id: null });
      }
    }
  });

  app.get("/mcp", (_req: Request, res: Response) => methodNotAllowed(res));
  app.delete("/mcp", (_req: Request, res: Response) => methodNotAllowed(res));
}
