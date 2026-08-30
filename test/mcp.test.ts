import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildApp } from "../src/server.js";
import { mountMcp } from "../src/mcp.js";
import { SessionStore } from "../src/store.js";
import { SessionService } from "../src/sessions.js";
import { RenderQueue, type RenderJob } from "../src/render.js";
import type {
  HostRenderer,
  HostRenderJob,
  HostPreviewJob,
  HostPreviewResult,
  HostRenderResult,
  HostCheckLayoutJob,
  HostCheckLayoutResult,
  LayoutIssue,
} from "../src/host-render.js";
import { makeBundle, GUIDE_MARKER } from "./helpers.js";
import { MARP_SYNTAX_REFERENCE } from "../src/marp-syntax-reference.js";
import type { Config } from "../src/config.js";
import { createBundleRef, type Bundle } from "../src/bundle.js";

// Spies on the real syncCanonicalDeckCache (still runs its real implementation, via
// importOriginal) so a test can assert how many times an example deck's canonical
// cache actually gets re-synced: two concurrent requests coalesced onto the same
// render-queue key (see mcp.ts's makeCoalescer) must produce exactly one re-sync, not
// one per request.
vi.mock("../src/artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/artifacts.js")>();
  return { ...actual, syncCanonicalDeckCache: vi.fn(actual.syncCanonicalDeckCache) };
});

function fakeHostRenderer(): HostRenderer & {
  previewCalls: HostPreviewJob[];
  previewResult: HostPreviewResult;
  checkLayoutCalls: HostCheckLayoutJob[];
  checkLayoutResult: HostCheckLayoutResult;
} {
  const previewCalls: HostPreviewJob[] = [];
  const checkLayoutCalls: HostCheckLayoutJob[] = [];
  const state = {
    previewResult: { code: 0, output: "", pngs: [] as string[] } as HostPreviewResult,
    checkLayoutResult: { code: 0, output: "", issues: [] as LayoutIssue[] } as HostCheckLayoutResult,
  };
  return {
    previewCalls,
    checkLayoutCalls,
    get previewResult(): HostPreviewResult {
      return state.previewResult;
    },
    set previewResult(v: HostPreviewResult) {
      state.previewResult = v;
    },
    get checkLayoutResult(): HostCheckLayoutResult {
      return state.checkLayoutResult;
    },
    set checkLayoutResult(v: HostCheckLayoutResult) {
      state.checkLayoutResult = v;
    },
    render: (_job: HostRenderJob): Promise<HostRenderResult> => Promise.resolve({ code: 0, output: "" }),
    renderPreviews: (job: HostPreviewJob): Promise<HostPreviewResult> => {
      previewCalls.push(job);
      return Promise.resolve(state.previewResult);
    },
    checkLayout: (job: HostCheckLayoutJob): Promise<HostCheckLayoutResult> => {
      checkLayoutCalls.push(job);
      return Promise.resolve(state.checkLayoutResult);
    },
  };
}

function makePngFixture(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(marker));
  return p;
}

function examplesDirOf(bundle: Bundle): string {
  if (bundle.examplesDir === undefined) throw new Error("test bundle has no examples dir");
  return bundle.examplesDir;
}

interface TestCtx {
  cfg: Config;
  bundle: Bundle;
  store: SessionStore;
  renders: RenderQueue;
  jobsRun: RenderJob[];
  hostRenderer: ReturnType<typeof fakeHostRenderer>;
  localSessionsRoot: string;
  httpServer: Server;
  port: number;
}

let ctx: TestCtx;

beforeEach(async () => {
  const bundle = makeBundle();
  const localSessionsRoot = mkdtempSync(join(tmpdir(), "deckd-mcp-local-"));
  const cfg: Config = {
    port: 0,
    dbPath: ":memory:",
    devUser: "dev@example.com",
    bundleDir: "/tmp/deckd-mcp-bundle-unused",
    scratchDir: "/tmp/deckd-mcp-scratch-unused",
    canonicalCacheDir: mkdtempSync(join(tmpdir(), "deckd-mcp-cache-")),
    localSessionsRoot,
    chromePath: "/tmp/deckd-mcp-chrome-unused",
  };
  const store = new SessionStore(":memory:");
  const jobsRun: RenderJob[] = [];
  const renders = new RenderQueue(async (job) => {
    jobsRun.push(job);
    return { code: 0, output: `rendered ${job.slug}` };
  });
  const bundleRef = createBundleRef(bundle);
  const sessions = new SessionService(store, cfg, bundleRef);
  const hostRenderer = fakeHostRenderer();

  // mountMcp must register /mcp's own json() parser before buildApp's global one
  // mounts, so a large MCP body is parsed by /mcp's limit rather than the global
  // route's smaller one (Express has no other way to give one path a bigger limit).
  const app = express();
  mountMcp(app, { cfg, bundleRef, sessions, store, renders, hostRenderer });
  buildApp({ cfg, bundleRef, store, sessions, renders, app });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  ctx = { cfg, bundle, store, renders, jobsRun, hostRenderer, localSessionsRoot, httpServer, port };
});

afterEach(async () => {
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()));
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.port}/mcp`));
  await client.connect(transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected a text content block first");
  return first.text;
}

function jsonOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

describe("MCP server", () => {
  it("exposes instructions and all 10 tools on initialize", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("read_guide");
    expect(client.getInstructions()).toContain("check_deck");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "check_deck", "create_session", "export_deck", "get_deck", "get_slide_previews", "list_examples",
        "list_sessions", "read_guide", "upload_asset", "write_slides",
      ].sort(),
    );
    await client.close();
  });

  it("GET and DELETE /mcp are method-not-allowed in stateless mode", async () => {
    const getRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp`);
    expect(getRes.status).toBe(405);
    const delRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, { method: "DELETE" });
    expect(delRes.status).toBe(405);
  });

  it("read_guide includes the bundle's guide content", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "read_guide", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(textOf(r as CallToolResult)).toContain(GUIDE_MARKER);
    expect(textOf(r as CallToolResult)).toContain("Write decks like this.");
    await client.close();
  });

  it("read_guide appends the built-in Marp syntax reference after the bundle guide", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "read_guide", arguments: {} });
    expect(r.isError).toBeFalsy();
    const text = textOf(r as CallToolResult);
    expect(text).toContain("## Marp syntax reference (built-in)");
    expect(text.indexOf(GUIDE_MARKER)).toBeLessThan(text.indexOf("## Marp syntax reference (built-in)"));
    expect(text).toContain(MARP_SYNTAX_REFERENCE);
    await client.close();
  });

  it("the built-in Marp syntax reference covers front-matter, backgrounds, scoped directives, and notes", () => {
    expect(MARP_SYNTAX_REFERENCE).toContain("marp: true");
    expect(MARP_SYNTAX_REFERENCE).toContain("![bg]");
    expect(MARP_SYNTAX_REFERENCE).toContain("_class");
    expect(MARP_SYNTAX_REFERENCE).toContain("presenter notes");
  });

  it("list_examples lists canonical decks from the bundle", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "list_examples", arguments: {} });
    expect(jsonOf(r as CallToolResult)).toEqual(["template-gallery"]);
    await client.close();
  });

  describe("bundle with no examples or guide", () => {
    // A fresh server on a bundle that declares neither -- not ctx's own, which
    // always has both -- so list_examples/get_deck/get_slide_previews/check_deck's
    // "no examples" branches and read_guide's "no guide" branch are exercised
    // against a bundle that genuinely has neither, rather than one that merely
    // lacks a requested example.
    async function connectToBareBundle(): Promise<{ client: Client; httpServer: Server }> {
      const bundle = makeBundle({ examples: false, guide: false });
      const bareBundleRef = createBundleRef(bundle);
      const app = express();
      mountMcp(app, {
        cfg: ctx.cfg, bundleRef: bareBundleRef, sessions: new SessionService(ctx.store, ctx.cfg, bareBundleRef), store: ctx.store,
        renders: ctx.renders, hostRenderer: ctx.hostRenderer,
      });
      const httpServer = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
      const port = (httpServer.address() as AddressInfo).port;
      const client = new Client({ name: "test-client-bare-bundle", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      return { client, httpServer };
    }

    it("list_examples returns an empty list", async () => {
      const { client, httpServer } = await connectToBareBundle();
      const r = await client.callTool({ name: "list_examples", arguments: {} });
      expect(jsonOf(r as CallToolResult)).toEqual([]);
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("get_deck on an example errors clearly instead of throwing", async () => {
      const { client, httpServer } = await connectToBareBundle();
      const r = await client.callTool({ name: "get_deck", arguments: { example: "template-gallery" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/unknown example deck/);
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("read_guide returns a clear message instead of guide content", async () => {
      const { client, httpServer } = await connectToBareBundle();
      const r = await client.callTool({ name: "read_guide", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(textOf(r as CallToolResult)).toMatch(/no guide/);
      await client.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
  });

  it("full loop: create_session -> write_slides (with render) -> get_deck", async () => {
    const client = await connect();

    const created = await client.callTool({ name: "create_session", arguments: { slug: "my-deck" } });
    expect(created.isError).toBeFalsy();
    const { id, slug } = jsonOf(created as CallToolResult) as { id: string; slug: string };
    expect(slug).toBe("my-deck");
    expect(existsSync(join(ctx.localSessionsRoot, id, "presentations/my-deck/slides.md"))).toBe(true);

    const deck1 = jsonOf((await client.callTool({ name: "get_deck", arguments: { session_id: id } })) as CallToolResult) as {
      markdown: string;
      mtime: number;
    };
    expect(deck1.markdown).toContain("# my-deck");

    const written = await client.callTool({
      name: "write_slides",
      arguments: { session_id: id, markdown: "# edited deck", base_mtime: deck1.mtime },
    });
    expect(written.isError).toBeFalsy();
    const writeResult = jsonOf(written as CallToolResult) as {
      mtime: number;
      render_code: number;
      render_output: string;
      layout_issues: unknown[];
    };
    expect(writeResult.render_code).toBe(0);
    expect(writeResult.render_output).toContain("rendered my-deck");
    expect(writeResult.layout_issues).toEqual([]);
    expect(ctx.jobsRun.at(-1)).toMatchObject({ slug: "my-deck", key: `${id}:my-deck` });
    expect(ctx.hostRenderer.checkLayoutCalls.at(-1)).toMatchObject({ key: `${id}:my-deck`, slug: "my-deck" });

    const deck2 = jsonOf((await client.callTool({ name: "get_deck", arguments: { session_id: id } })) as CallToolResult) as {
      markdown: string;
    };
    expect(deck2.markdown).toBe("# edited deck");

    await client.close();
  });

  it("create_session rejects a slug that fails SLUG_RE with a clear error", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "create_session", arguments: { slug: "Not A Slug!" } });
    expect(r.isError).toBe(true);
    expect(textOf(r as CallToolResult)).toMatch(/invalid slug/);
    await client.close();
  });

  it("write_slides with a stale base_mtime returns the fresh content and mtime instead of throwing", async () => {
    const client = await connect();
    const created = jsonOf(
      (await client.callTool({ name: "create_session", arguments: { slug: "conflict-deck" } })) as CallToolResult,
    ) as { id: string };

    const r = await client.callTool({
      name: "write_slides",
      arguments: { session_id: created.id, markdown: "# stale write", base_mtime: 1 },
    });
    expect(r.isError).toBe(true);
    const body = jsonOf(r as CallToolResult) as { error: string; mtime: number; content: string };
    expect(body.error).toMatch(/modified on disk/);
    expect(body.content).toContain("# conflict-deck");
    expect(typeof body.mtime).toBe("number");
    await client.close();
  });

  it("write_slides on an unknown session_id errors instead of throwing", async () => {
    const client = await connect();
    const r = await client.callTool({
      name: "write_slides",
      arguments: { session_id: "not-a-real-session-id", markdown: "# x", base_mtime: 0 },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r as CallToolResult)).toMatch(/no such session/);
    await client.close();
  });

  it("list_sessions returns only local sessions for the dev user", async () => {
    const client = await connect();
    const created = jsonOf(
      (await client.callTool({ name: "create_session", arguments: { slug: "listed-deck" } })) as CallToolResult,
    ) as { id: string; slug: string };
    // A sandbox-kind row for the same user must not show up via MCP.
    ctx.store.create({
      id: "sandbox-row", userEmail: ctx.cfg.devUser, name: "n", slug: "n", appId: "a", sandboxId: "s", kind: "sandbox",
    });

    const r = await client.callTool({ name: "list_sessions", arguments: {} });
    const rows = jsonOf(r as CallToolResult) as Array<{ id: string; slug: string; createdAt: number; updatedAt: number }>;
    expect(rows.map((row) => row.id)).toEqual([created.id]);
    expect(rows[0]?.slug).toBe("listed-deck");
    expect(typeof rows[0]?.createdAt).toBe("number");
    expect(typeof rows[0]?.updatedAt).toBe("number");
    await client.close();
  });

  describe("get_deck", () => {
    it("reads an example deck read-only from the bundle's examples dir", async () => {
      const client = await connect();
      const r = await client.callTool({ name: "get_deck", arguments: { example: "template-gallery" } });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { slug: string; markdown: string; assets: Array<{ path: string }> };
      expect(body.slug).toBe("template-gallery");
      expect(body.markdown).toContain("Template gallery");
      await client.close();
    });

    it("errors when both session_id and example are given", async () => {
      const client = await connect();
      const r = await client.callTool({
        name: "get_deck",
        arguments: { session_id: "x", example: "template-gallery" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/exactly one of/);
      await client.close();
    });

    it("errors when neither session_id nor example is given", async () => {
      const client = await connect();
      const r = await client.callTool({ name: "get_deck", arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/exactly one of/);
      await client.close();
    });

    it("errors on an unknown example", async () => {
      const client = await connect();
      const r = await client.callTool({ name: "get_deck", arguments: { example: "does-not-exist" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/unknown example/);
      await client.close();
    });

    it("lists assets recursively, excluding preview/ and slides.md", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "asset-deck" } })) as CallToolResult,
      ) as { id: string };
      const deckDir = join(ctx.localSessionsRoot, created.id, "presentations/asset-deck");
      mkdirSync(join(deckDir, "images"), { recursive: true });
      mkdirSync(join(deckDir, "preview"), { recursive: true });
      writeFileSync(join(deckDir, "images", "logo.png"), "png-bytes");
      writeFileSync(join(deckDir, "preview", "asset-deck.001.png"), "preview-bytes");

      const r = await client.callTool({ name: "get_deck", arguments: { session_id: created.id } });
      const body = jsonOf(r as CallToolResult) as { assets: Array<{ path: string; size: number }> };
      const paths = body.assets.map((a) => a.path);
      expect(paths).toContain("images/logo.png");
      expect(paths.some((p) => p.startsWith("preview/"))).toBe(false);
      expect(paths).not.toContain("slides.md");
      await client.close();
    });
  });

  describe("upload_asset", () => {
    it("saves into images/ or charts/ and returns the relative path", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "upload-deck" } })) as CallToolResult,
      ) as { id: string };

      const r1 = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: created.id, path: "images/logo.png", data_base64: Buffer.from("png-data").toString("base64") },
      });
      expect(r1.isError).toBeFalsy();
      expect(jsonOf(r1 as CallToolResult)).toEqual({ path: "images/logo.png" });
      expect(existsSync(join(ctx.localSessionsRoot, created.id, "presentations/upload-deck/images/logo.png"))).toBe(true);

      const r2 = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: created.id, path: "charts/plot.svg", data_base64: Buffer.from("<svg/>").toString("base64") },
      });
      expect(jsonOf(r2 as CallToolResult)).toEqual({ path: "charts/plot.svg" });
      await client.close();
    });

    it("rejects path traversal", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "traversal-deck" } })) as CallToolResult,
      ) as { id: string };
      const r = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: created.id, path: "../evil.png", data_base64: Buffer.from("x").toString("base64") },
      });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects a disallowed extension", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "ext-deck" } })) as CallToolResult,
      ) as { id: string };
      const r = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: created.id, path: "images/evil.exe", data_base64: Buffer.from("x").toString("base64") },
      });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects data over the 10MB decoded cap", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "big-deck" } })) as CallToolResult,
      ) as { id: string };
      const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
      const r = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: created.id, path: "images/big.png", data_base64: big },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 20_000);
  });

  describe("get_slide_previews", () => {
    it("returns image content blocks for a local session's own deck", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "preview-deck" } })) as CallToolResult,
      ) as { id: string };

      const fixtureDir = mkdtempSync(join(tmpdir(), "deckd-mcp-pngs-"));
      const pngs = [
        makePngFixture(fixtureDir, "preview-deck.001.png", "page-1"),
        makePngFixture(fixtureDir, "preview-deck.002.png", "page-2"),
      ];
      ctx.hostRenderer.previewResult = { code: 0, output: "ok", pngs };

      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: created.id } });
      expect(r.isError).toBeFalsy();
      const content = (r as CallToolResult).content;
      expect(content[0]?.type).toBe("text");
      const images = content.filter((c) => c.type === "image");
      expect(images).toHaveLength(2);
      expect(images.every((img) => img.type === "image" && img.mimeType === "image/png")).toBe(true);
      expect(images[0]?.type === "image" && Buffer.from(images[0].data, "base64").toString("utf8")).toBe("page-1");

      expect(ctx.hostRenderer.previewCalls.at(-1)).toMatchObject({ key: `${created.id}:preview-deck`, slug: "preview-deck" });
      await client.close();
    });

    // The text block names the bundle's effective imageScale (default 2, see
    // bundle.ts's RENDER_DEFAULTS) so an agent reading the previews knows what scale
    // it was rendered at, without having to separately inspect the bundle.
    it("reports the bundle's effective imageScale in the returned text block", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "scale-deck" } })) as CallToolResult,
      ) as { id: string };
      const fixtureDir = mkdtempSync(join(tmpdir(), "deckd-mcp-pngs-"));
      ctx.hostRenderer.previewResult = {
        code: 0,
        output: "ok",
        pngs: [makePngFixture(fixtureDir, "scale-deck.001.png", "page-1")],
      };

      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: created.id } });
      expect(textOf(r as CallToolResult)).toContain("scale 2");
      await client.close();
    });

    it("honors the pages argument", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "pages-deck" } })) as CallToolResult,
      ) as { id: string };
      const fixtureDir = mkdtempSync(join(tmpdir(), "deckd-mcp-pngs-"));
      ctx.hostRenderer.previewResult = {
        code: 0,
        output: "ok",
        pngs: [1, 2, 3].map((n) => makePngFixture(fixtureDir, `pages-deck.00${n}.png`, `page-${n}`)),
      };

      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: created.id, pages: [2] } });
      const images = (r as CallToolResult).content.filter((c) => c.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0]?.type === "image" && Buffer.from(images[0].data, "base64").toString("utf8")).toBe("page-2");
      await client.close();
    });

    it("renders an example deck via the canonical cache, never the bundle itself", async () => {
      const client = await connect();
      const fixtureDir = mkdtempSync(join(tmpdir(), "deckd-mcp-pngs-"));
      ctx.hostRenderer.previewResult = {
        code: 0,
        output: "ok",
        pngs: [makePngFixture(fixtureDir, "template-gallery.001.png", "example-page-1")],
      };

      const r = await client.callTool({ name: "get_slide_previews", arguments: { example: "template-gallery" } });
      expect(r.isError).toBeFalsy();
      const call = ctx.hostRenderer.previewCalls.at(-1);
      expect(call).toMatchObject({ key: "canonical:template-gallery", slug: "template-gallery" });
      expect(call?.deckDir.startsWith(ctx.cfg.canonicalCacheDir)).toBe(true);
      expect(call?.deckDir.startsWith(examplesDirOf(ctx.bundle))).toBe(false);
      await client.close();
    });

    it("returns an error result when the render fails, instead of throwing", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "broken-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.previewResult = { code: 1, output: "marp blew up", pngs: [] };

      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: created.id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toContain("marp blew up");
      await client.close();
    });

    it("rejects a pages array longer than 40", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "toomany-pages-deck" } })) as CallToolResult,
      ) as { id: string };
      const pages = Array.from({ length: 41 }, (_, i) => i + 1);
      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: created.id, pages } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/pages/);
      await client.close();
    });
  });

  describe("write_slides layout_issues", () => {
    it("reports overflow issues found by the layout check", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "overflow-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.checkLayoutResult = {
        code: 0, output: "ok", issues: [{ slide: 3, kind: "overflow-y", amountPx: 40 }],
      };

      const deck = jsonOf(
        (await client.callTool({ name: "get_deck", arguments: { session_id: created.id } })) as CallToolResult,
      ) as { mtime: number };
      const r = await client.callTool({
        name: "write_slides",
        arguments: { session_id: created.id, markdown: "# edited", base_mtime: deck.mtime },
      });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { render_code: number; layout_issues: unknown };
      expect(body.render_code).toBe(0);
      expect(body.layout_issues).toEqual([{ slide: 3, kind: "overflow-y", amountPx: 40 }]);
      await client.close();
    });

    it("does not run a layout check when the render itself failed", async () => {
      // A fresh server on a render queue that always fails, so write_slides exercises
      // a non-zero render_code -- ctx's own server/renders are already wired together
      // by beforeEach and can't have their render queue swapped after the fact.
      const failingRenders = new RenderQueue(async (job) => {
        ctx.jobsRun.push(job);
        return { code: 1, output: "render blew up" };
      });
      const app = express();
      const failingBundleRef = createBundleRef(ctx.bundle);
      mountMcp(app, {
        cfg: ctx.cfg, bundleRef: failingBundleRef, sessions: new SessionService(ctx.store, ctx.cfg, failingBundleRef), store: ctx.store,
        renders: failingRenders, hostRenderer: ctx.hostRenderer,
      });
      const httpServer = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
      const port = (httpServer.address() as AddressInfo).port;
      const failClient = new Client({ name: "test-client-2", version: "1.0.0" });
      await failClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

      const created = jsonOf(
        (await failClient.callTool({ name: "create_session", arguments: { slug: "broken-render-deck" } })) as CallToolResult,
      ) as { id: string };
      const deck = jsonOf(
        (await failClient.callTool({ name: "get_deck", arguments: { session_id: created.id } })) as CallToolResult,
      ) as { mtime: number };
      const before = ctx.hostRenderer.checkLayoutCalls.length;
      const r = await failClient.callTool({
        name: "write_slides",
        arguments: { session_id: created.id, markdown: "# x", base_mtime: deck.mtime },
      });
      const body = jsonOf(r as CallToolResult) as { render_code: number; layout_issues?: unknown };
      expect(body.render_code).toBe(1);
      expect(body.layout_issues).toBeUndefined();
      expect(ctx.hostRenderer.checkLayoutCalls.length).toBe(before);

      await failClient.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("includes a note instead of failing the save when the layout check itself fails", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "checkfail-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.checkLayoutResult = { code: -1, output: "chrome not found", issues: [] };

      const deck = jsonOf(
        (await client.callTool({ name: "get_deck", arguments: { session_id: created.id } })) as CallToolResult,
      ) as { mtime: number };
      const r = await client.callTool({
        name: "write_slides",
        arguments: { session_id: created.id, markdown: "# edited", base_mtime: deck.mtime },
      });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { render_code: number; layout_issues?: unknown; layout_check_note?: string };
      expect(body.render_code).toBe(0);
      expect(body.layout_issues).toBeUndefined();
      expect(body.layout_check_note).toMatch(/chrome not found/);
      await client.close();
    });
  });

  describe("check_deck", () => {
    it("returns a readable report and the structured issues for a session's own deck", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "checkdeck-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.checkLayoutResult = {
        code: 0, output: "ok", issues: [{ slide: 2, kind: "overflow-x", amountPx: 15 }],
      };

      const r = await client.callTool({ name: "check_deck", arguments: { session_id: created.id } });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { report: string; issues: unknown[] };
      expect(body.report).toMatch(/overflow-x/);
      expect(body.issues).toEqual([{ slide: 2, kind: "overflow-x", amountPx: 15 }]);
      expect(ctx.hostRenderer.checkLayoutCalls.at(-1)).toMatchObject({ key: `${created.id}:checkdeck-deck`, slug: "checkdeck-deck" });
      await client.close();
    });

    it("reports a clean deck clearly", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "clean-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.checkLayoutResult = { code: 0, output: "ok", issues: [] };

      const r = await client.callTool({ name: "check_deck", arguments: { session_id: created.id } });
      const body = jsonOf(r as CallToolResult) as { report: string; issues: unknown[] };
      expect(body.report).toMatch(/no layout issues/i);
      expect(body.issues).toEqual([]);
      await client.close();
    });

    it("checks an example deck via the canonical cache, never the bundle itself", async () => {
      const client = await connect();
      ctx.hostRenderer.checkLayoutResult = { code: 0, output: "ok", issues: [] };

      const r = await client.callTool({ name: "check_deck", arguments: { example: "template-gallery" } });
      expect(r.isError).toBeFalsy();
      const call = ctx.hostRenderer.checkLayoutCalls.at(-1);
      expect(call).toMatchObject({ key: "canonical:template-gallery", slug: "template-gallery" });
      expect(call?.deckDir.startsWith(ctx.cfg.canonicalCacheDir)).toBe(true);
      expect(call?.deckDir.startsWith(examplesDirOf(ctx.bundle))).toBe(false);
      await client.close();
    });

    it("returns an error result when the layout check fails, instead of throwing", async () => {
      const client = await connect();
      const created = jsonOf(
        (await client.callTool({ name: "create_session", arguments: { slug: "checkdeck-fail-deck" } })) as CallToolResult,
      ) as { id: string };
      ctx.hostRenderer.checkLayoutResult = { code: 1, output: "marp blew up", issues: [] };

      const r = await client.callTool({ name: "check_deck", arguments: { session_id: created.id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toContain("marp blew up");
      await client.close();
    });

    it("errors when neither session_id nor example is given", async () => {
      const client = await connect();
      const r = await client.callTool({ name: "check_deck", arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/exactly one of/);
      await client.close();
    });
  });

  describe("concurrent requests for the same example deck", () => {
    // A short artificial delay on the host-render call itself (not on the cache sync)
    // is what actually creates the overlap this test needs: with the fake renderer's
    // real (near-instant) resolution, the first HTTP request's whole round trip -- sync,
    // render, response -- completes before the second one is even dispatched, so the
    // coalescer's in-flight map is never actually shared and the assertion below would
    // pass regardless of whether re-syncing is coalesced.
    function delayHostRender<T extends { renderPreviews: unknown; checkLayout: unknown }>(hostRenderer: T, ms: number): void {
      const originalPreviews = hostRenderer.renderPreviews as (...args: unknown[]) => Promise<unknown>;
      const originalCheckLayout = hostRenderer.checkLayout as (...args: unknown[]) => Promise<unknown>;
      hostRenderer.renderPreviews = (async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, ms));
        return originalPreviews(...args);
      }) as T["renderPreviews"];
      hostRenderer.checkLayout = (async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, ms));
        return originalCheckLayout(...args);
      }) as T["checkLayout"];
    }

    it("re-syncs the canonical cache once, not once per request, for two concurrent get_slide_previews calls", async () => {
      delayHostRender(ctx.hostRenderer, 100);
      const client = await connect();
      const syncSpy = vi.mocked((await import("../src/artifacts.js")).syncCanonicalDeckCache);
      const before = syncSpy.mock.calls.length;

      const [r1, r2] = await Promise.all([
        client.callTool({ name: "get_slide_previews", arguments: { example: "template-gallery" } }),
        client.callTool({ name: "get_slide_previews", arguments: { example: "template-gallery" } }),
      ]);

      expect((r1 as CallToolResult).isError).toBeFalsy();
      expect((r2 as CallToolResult).isError).toBeFalsy();
      expect(syncSpy.mock.calls.length - before).toBe(1);
      expect(ctx.hostRenderer.previewCalls).toHaveLength(1);
      await client.close();
    });

    it("re-syncs the canonical cache once, not once per request, for two concurrent check_deck calls", async () => {
      delayHostRender(ctx.hostRenderer, 100);
      const client = await connect();
      const syncSpy = vi.mocked((await import("../src/artifacts.js")).syncCanonicalDeckCache);
      const before = syncSpy.mock.calls.length;
      ctx.hostRenderer.checkLayoutResult = { code: 0, output: "ok", issues: [] };

      const [r1, r2] = await Promise.all([
        client.callTool({ name: "check_deck", arguments: { example: "template-gallery" } }),
        client.callTool({ name: "check_deck", arguments: { example: "template-gallery" } }),
      ]);

      expect((r1 as CallToolResult).isError).toBeFalsy();
      expect((r2 as CallToolResult).isError).toBeFalsy();
      expect(syncSpy.mock.calls.length - before).toBe(1);
      expect(ctx.hostRenderer.checkLayoutCalls).toHaveLength(1);
      await client.close();
    });
  });

  describe("legacy sandbox-row isolation", () => {
    function seedSandboxRow(): string {
      const id = "sandbox-row";
      ctx.store.create({
        id, userEmail: ctx.cfg.devUser, name: "n", slug: "n", appId: "a", sandboxId: "s", kind: "sandbox",
      });
      return id;
    }

    it("write_slides rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({
        name: "write_slides",
        arguments: { session_id: id, markdown: "# x", base_mtime: 0 },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });

    it("get_deck rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({ name: "get_deck", arguments: { session_id: id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });

    it("upload_asset rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({
        name: "upload_asset",
        arguments: { session_id: id, path: "images/logo.png", data_base64: Buffer.from("x").toString("base64") },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });

    it("get_slide_previews rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({ name: "get_slide_previews", arguments: { session_id: id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });

    it("export_deck rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({ name: "export_deck", arguments: { session_id: id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });

    it("check_deck rejects a sandbox-kind session_id", async () => {
      const client = await connect();
      const id = seedSandboxRow();
      const r = await client.callTool({ name: "check_deck", arguments: { session_id: id } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/has not been migrated to a local session/);
      await client.close();
    });
  });

  it("scopes the 20mb JSON limit to /mcp only; other routes cap at 2mb", async () => {
    const bigContent = "a".repeat(3 * 1024 * 1024); // > 2mb global cap, < 20mb /mcp cap
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions/anything/source`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: bigContent, baseMtime: 0 }),
    });
    expect(res.status).toBe(413);

    const client = await connect();
    const created = jsonOf(
      (await client.callTool({ name: "create_session", arguments: { slug: "big-body-deck" } })) as CallToolResult,
    ) as { id: string };
    // Base64 of 3MB is ~4MB: over the 2mb global cap, under both /mcp's 20mb JSON
    // cap and upload_asset's 10MB decoded cap.
    const bigAsset = Buffer.alloc(3 * 1024 * 1024).toString("base64");
    const r = await client.callTool({
      name: "upload_asset",
      arguments: { session_id: created.id, path: "images/big-but-ok.png", data_base64: bigAsset },
    });
    expect(r.isError).toBeFalsy();
    await client.close();
  }, 20_000);

  it("export_deck returns the download URL and a description of the zip contents", async () => {
    const client = await connect();
    const created = jsonOf(
      (await client.callTool({ name: "create_session", arguments: { slug: "export-deck" } })) as CallToolResult,
    ) as { id: string };
    const r = await client.callTool({ name: "export_deck", arguments: { session_id: created.id } });
    expect(r.isError).toBeFalsy();
    const text = textOf(r as CallToolResult);
    expect(text).toContain(`/api/sessions/${created.id}/export`);
    expect(text.toLowerCase()).toContain("zip");
    await client.close();
  });
});
