import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildApp } from "../src/server.js";
import { mountMcp } from "../src/mcp.js";
import { mountMcpAdmin, MAX_MCP_BUNDLE_UPLOAD_BYTES } from "../src/mcp-admin.js";
import { SessionStore } from "../src/store.js";
import { SessionService } from "../src/sessions.js";
import { RenderQueue, createRenderRunner } from "../src/render.js";
import { createHostRenderer, type SpawnFn } from "../src/host-render.js";
import { createBundleRef, loadBundle, type BundleRef, type BundleWriter } from "../src/bundle.js";
import { MAX_BUNDLE_FILE_BYTES } from "../src/bundle-upload.js";
import type { Config } from "../src/config.js";

// Same stub as server-bundle.test.ts: whatever "theme.css" resolves to in the
// render's scratch dir is copied verbatim into the -o target, so a test can prove a
// render actually read the CURRENT bundle's theme content by reading the "pdf" back.
const STUB_MARP = `#!/bin/bash
set -euo pipefail
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
mkdir -p "$(dirname "$out")"
cat theme.css > "$out"
`;

function scratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeStubMarp(dir: string): string {
  const p = join(dir, "stub-marp.sh");
  writeFileSync(p, STUB_MARP);
  chmodSync(p, 0o755);
  return p;
}

function makeExec(marpPath: string): SpawnFn {
  return (command, args, options) => {
    const script = command === "stub-marp" ? marpPath : command;
    return spawn(script, args, { cwd: options.cwd, env: options.env, detached: true });
  };
}

function writeBundleTree(dir: string, themeMarker: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.css"), `/* ${themeMarker} */\n`);
  mkdirSync(join(dir, "presentations", "example-deck"), { recursive: true });
  writeFileSync(join(dir, "presentations", "example-deck", "slides.md"), "# Example\n");
  writeFileSync(join(dir, "deckd.json"), JSON.stringify({ theme: "theme.css", examples: "presentations" }));
}

function zipDir(srcDir: string): Buffer {
  const zipPath = join(scratchDir("deckd-mcp-admin-zip-"), "bundle.zip");
  execFileSync("zip", ["-r", zipPath, "."], { cwd: srcDir });
  return readFileSync(zipPath);
}

async function waitForRenderSettle(app: Express, sessionId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await request(app).get(`/api/sessions/${sessionId}`);
    if (!r.body.render.rendering && !r.body.render.queued) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("render did not settle in time");
}

interface TestCtx {
  cfg: Config;
  bundleRef: BundleRef & BundleWriter;
  app: Express;
  httpServer: Server;
  port: number;
}

let ctx: TestCtx;

beforeEach(async () => {
  const dataDir = scratchDir("deckd-mcp-admin-data-");
  const cfg: Config = {
    port: 0,
    dbPath: ":memory:",
    devUser: "dev@example.com",
    bundleDir: join(dataDir, "bundle"),
    scratchDir: join(dataDir, "render-scratch"),
    canonicalCacheDir: join(dataDir, "canonical-cache"),
    localSessionsRoot: join(dataDir, "local-sessions"),
    chromePath: "/tmp/deckd-mcp-admin-chrome-unused",
  };
  writeBundleTree(cfg.bundleDir, "v1");
  const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));
  const store = new SessionStore(":memory:");
  const sessions = new SessionService(store, cfg, bundleRef);
  const marpPath = makeStubMarp(dataDir);
  const hostRenderer = createHostRenderer({
    bundleRef, scratchRoot: cfg.scratchDir, env: { PATH: process.env.PATH ?? "" },
    exec: makeExec(marpPath), marpBinPath: "stub-marp",
  });
  const renders = new RenderQueue(createRenderRunner(hostRenderer), 2);

  const app = express();
  mountMcp(app, { cfg, bundleRef, sessions, store, renders, hostRenderer });
  mountMcpAdmin(app, { cfg, bundleRef });
  buildApp({ cfg, bundleRef, store, sessions, renders, app });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  ctx = { cfg, bundleRef, app, httpServer, port };
});

afterEach(async () => {
  await new Promise<void>((resolve) => ctx.httpServer.close(() => resolve()));
});

async function connectAdmin(): Promise<Client> {
  const client = new Client({ name: "test-admin-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.port}/mcp-admin`)));
  return client;
}

async function connectDeck(): Promise<Client> {
  const client = new Client({ name: "test-deck-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.port}/mcp`)));
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

describe("admin MCP (/mcp-admin)", () => {
  it("GET and DELETE /mcp-admin are method-not-allowed in stateless mode", async () => {
    const getRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp-admin`);
    expect(getRes.status).toBe(405);
    const delRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp-admin`, { method: "DELETE" });
    expect(delRes.status).toBe(405);
  });

  it("exposes exactly the 6 bundle-management tools", async () => {
    const client = await connectAdmin();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["delete_bundle_file", "download_bundle", "get_bundle_info", "read_bundle_file", "upload_bundle", "write_bundle_file"].sort(),
    );
    await client.close();
  });

  it("the deck-editing /mcp exposes no bundle tools at all", async () => {
    const client = await connectDeck();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "check_deck", "create_session", "export_deck", "get_deck", "get_slide_previews", "list_examples",
        "list_sessions", "read_guide", "upload_asset", "write_slides",
      ].sort(),
    );
    for (const bundleTool of ["get_bundle_info", "read_bundle_file", "write_bundle_file", "delete_bundle_file", "upload_bundle", "download_bundle"]) {
      expect(names).not.toContain(bundleTool);
    }
    await client.close();
  });

  describe("get_bundle_info", () => {
    it("returns the manifest and a recursive file listing", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "get_bundle_info", arguments: {} });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { manifest: { theme: string }; files: Array<{ path: string; size: number; mtime: number }> };
      expect(body.manifest).toEqual({ theme: "theme.css", assets: undefined, examples: "presentations", guide: undefined });
      const paths = body.files.map((f) => f.path);
      expect(paths).toContain("theme.css");
      expect(paths).toContain("deckd.json");
      expect(paths).toContain("presentations/example-deck/slides.md");
      await client.close();
    });
  });

  describe("read_bundle_file", () => {
    it("reads a text file as UTF-8", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "theme.css" } });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { path: string; encoding: string; content: string; mtime: number };
      expect(body.encoding).toBe("utf8");
      expect(body.content).toContain("v1");
      expect(typeof body.mtime).toBe("number");
      await client.close();
    });

    it("reads a binary file as base64", async () => {
      writeFileSync(join(ctx.cfg.bundleDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]));
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "logo.png" } });
      expect(r.isError).toBeFalsy();
      const body = jsonOf(r as CallToolResult) as { encoding: string; data_base64: string; size: number };
      expect(body.encoding).toBe("base64");
      expect(Buffer.from(body.data_base64, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]));
      await client.close();
    });

    it("rejects a binary file over the 5MB read cap with a clear error", async () => {
      writeFileSync(join(ctx.cfg.bundleDir, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "huge.png" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 20_000);

    // Regression: the size cap originally gated only the binary branch, so a large
    // text file (e.g. a big guide) could be read uncapped.
    it("rejects a text file over the 5MB read cap with a clear error", async () => {
      writeFileSync(join(ctx.cfg.bundleDir, "huge.md"), "a".repeat(5 * 1024 * 1024 + 1));
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "huge.md" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 20_000);

    it("errors clearly on a missing file", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "does-not-exist.css" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/not found/);
      await client.close();
    });

    it("rejects a path that traverses outside the bundle", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "../evil.css" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects an absolute path", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "read_bundle_file", arguments: { path: "/etc/passwd" } });
      expect(r.isError).toBe(true);
      await client.close();
    });
  });

  describe("write_bundle_file", () => {
    it("writes a new theme.css and a subsequent render picks it up", async () => {
      const created = await request(ctx.app).post("/api/sessions").send({ name: "d" });
      const sessionId: string = created.body.id;
      const slug: string = created.body.slug;
      const pdfPath = join(ctx.cfg.localSessionsRoot, sessionId, "presentations", slug, `${slug}.pdf`);

      await request(ctx.app).post(`/api/sessions/${sessionId}/render`).query({ deck: slug });
      await waitForRenderSettle(ctx.app, sessionId);
      expect(readFileSync(pdfPath, "utf8")).toContain("v1");

      const client = await connectAdmin();
      const w = await client.callTool({ name: "write_bundle_file", arguments: { path: "theme.css", content: "/* v2 */\n" } });
      expect(w.isError).toBeFalsy();
      const wBody = jsonOf(w as CallToolResult) as { path: string; mtime: number };
      expect(wBody.path).toBe("theme.css");
      expect(typeof wBody.mtime).toBe("number");
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("v2");

      await request(ctx.app).post(`/api/sessions/${sessionId}/render`).query({ deck: slug });
      await waitForRenderSettle(ctx.app, sessionId);
      const after = readFileSync(pdfPath, "utf8");
      expect(after).toContain("v2");
      expect(after).not.toContain("v1");
      await client.close();
    });

    it("round-trips base_mtime: reading, then writing back the same content with that mtime succeeds", async () => {
      const client = await connectAdmin();
      const read = jsonOf(
        (await client.callTool({ name: "read_bundle_file", arguments: { path: "theme.css" } })) as CallToolResult,
      ) as { content: string; mtime: number };

      const w = await client.callTool({
        name: "write_bundle_file",
        arguments: { path: "theme.css", content: read.content, base_mtime: read.mtime },
      });
      expect(w.isError).toBeFalsy();
      await client.close();
    });

    it("rejects a stale base_mtime with the current mtime, leaving the file untouched", async () => {
      const client = await connectAdmin();
      const read = jsonOf(
        (await client.callTool({ name: "read_bundle_file", arguments: { path: "theme.css" } })) as CallToolResult,
      ) as { mtime: number };

      // Simulate a concurrent change: touch theme.css on disk with a distinctly later mtime.
      const themePath = join(ctx.cfg.bundleDir, "theme.css");
      writeFileSync(themePath, "/* changed-out-of-band */\n");
      const later = new Date(read.mtime + 60_000);
      utimesSync(themePath, later, later);

      const w = await client.callTool({
        name: "write_bundle_file",
        arguments: { path: "theme.css", content: "/* stale write */\n", base_mtime: read.mtime },
      });
      expect(w.isError).toBe(true);
      const body = jsonOf(w as CallToolResult) as { error: string; mtime: number };
      expect(body.error).toMatch(/modified on disk/);
      expect(body.mtime).toBeGreaterThan(read.mtime);
      expect(readFileSync(themePath, "utf8")).toContain("changed-out-of-band");
      await client.close();
    });

    it("rejects a disallowed file extension", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "run.sh", content: "echo hi\n" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/not allowed|allowlist/);
      expect(existsSync(join(ctx.cfg.bundleDir, "run.sh"))).toBe(false);
      await client.close();
    });

    it("rejects a path that traverses outside the bundle", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "../evil.css", content: "x" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects an absolute path", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "/etc/passwd", content: "x" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects writing to a path that is currently a directory", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "presentations", content: "x" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/directory/);
      await client.close();
    });

    it("rejects content over MAX_BUNDLE_FILE_BYTES", async () => {
      const client = await connectAdmin();
      const big = "a".repeat(MAX_BUNDLE_FILE_BYTES + 1);
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "theme.css", content: big } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 20_000);

    it("rejects data_base64 over MAX_BUNDLE_FILE_BYTES", async () => {
      const client = await connectAdmin();
      const big = Buffer.alloc(MAX_BUNDLE_FILE_BYTES + 1).toString("base64");
      const r = await client.callTool({ name: "write_bundle_file", arguments: { path: "theme.css", data_base64: big } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 20_000);

    it("rejects both content and data_base64 given together, or neither given", async () => {
      const client = await connectAdmin();
      const both = await client.callTool({
        name: "write_bundle_file",
        arguments: { path: "theme.css", content: "x", data_base64: Buffer.from("x").toString("base64") },
      });
      expect(both.isError).toBe(true);
      expect(textOf(both as CallToolResult)).toMatch(/exactly one of/);

      const neither = await client.callTool({ name: "write_bundle_file", arguments: { path: "theme.css" } });
      expect(neither.isError).toBe(true);
      expect(textOf(neither as CallToolResult)).toMatch(/exactly one of/);
      await client.close();
    });

    it("rejects a manifest edit that no longer resolves, leaving the live bundle unchanged", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({
        name: "write_bundle_file",
        arguments: { path: "deckd.json", content: JSON.stringify({ theme: "does-not-exist.css" }) },
      });
      expect(r.isError).toBe(true);
      const message = textOf(r as CallToolResult);
      expect(message).toMatch(/theme.*not found|not found.*theme/i);
      // Names the bundle-relative path the caller gave, not applyBundleEdit's own
      // staging temp dir.
      expect(message).not.toContain(ctx.cfg.bundleDir);
      expect(message).not.toMatch(/bundle\.edit-/);

      expect(ctx.bundleRef.current().dir).toBe(ctx.cfg.bundleDir);
      expect(readFileSync(join(ctx.cfg.bundleDir, "deckd.json"), "utf8")).toContain("theme.css");
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("v1");
      await client.close();
    });
  });

  describe("symlink defenses (created directly on disk in the bundle)", () => {
    it("rejects read/write/delete through a symlinked file (final path segment)", async () => {
      const outside = scratchDir("deckd-mcp-admin-outside-");
      writeFileSync(join(outside, "secret.css"), "/* secret */");
      symlinkSync(join(outside, "secret.css"), join(ctx.cfg.bundleDir, "linked.css"));
      const client = await connectAdmin();

      const read = await client.callTool({ name: "read_bundle_file", arguments: { path: "linked.css" } });
      expect(read.isError).toBe(true);
      expect(textOf(read as CallToolResult)).toMatch(/symlink/);

      const write = await client.callTool({ name: "write_bundle_file", arguments: { path: "linked.css", content: "x" } });
      expect(write.isError).toBe(true);
      expect(textOf(write as CallToolResult)).toMatch(/symlink/);

      const del = await client.callTool({ name: "delete_bundle_file", arguments: { path: "linked.css" } });
      expect(del.isError).toBe(true);
      expect(textOf(del as CallToolResult)).toMatch(/symlink/);

      await client.close();
    });

    it("rejects read/write/delete through a symlinked intermediate directory", async () => {
      const outsideDir = scratchDir("deckd-mcp-admin-outsidedir-");
      writeFileSync(join(outsideDir, "theme.css"), "/* outside */");
      symlinkSync(outsideDir, join(ctx.cfg.bundleDir, "linked-dir"));
      const client = await connectAdmin();

      const read = await client.callTool({ name: "read_bundle_file", arguments: { path: "linked-dir/theme.css" } });
      expect(read.isError).toBe(true);
      expect(textOf(read as CallToolResult)).toMatch(/symlink/);

      const write = await client.callTool({
        name: "write_bundle_file",
        arguments: { path: "linked-dir/theme.css", content: "x" },
      });
      expect(write.isError).toBe(true);
      expect(textOf(write as CallToolResult)).toMatch(/symlink/);

      const del = await client.callTool({ name: "delete_bundle_file", arguments: { path: "linked-dir/theme.css" } });
      expect(del.isError).toBe(true);
      expect(textOf(del as CallToolResult)).toMatch(/symlink/);

      await client.close();
    });
  });

  describe("delete_bundle_file", () => {
    it("deletes a file the manifest doesn't reference", async () => {
      writeFileSync(join(ctx.cfg.bundleDir, "scratch.md"), "# scratch\n");
      const client = await connectAdmin();
      const r = await client.callTool({ name: "delete_bundle_file", arguments: { path: "scratch.md" } });
      expect(r.isError).toBeFalsy();
      expect(existsSync(join(ctx.bundleRef.current().dir, "scratch.md"))).toBe(false);
      await client.close();
    });

    it("rejects deleting the manifest-referenced theme, naming the manifest reference", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "delete_bundle_file", arguments: { path: "theme.css" } });
      expect(r.isError).toBe(true);
      const message = textOf(r as CallToolResult);
      expect(message).toMatch(/theme/i);
      // Names the bundle-relative path, not applyBundleEdit's own staging temp dir.
      expect(message).not.toContain(ctx.cfg.bundleDir);
      expect(message).not.toMatch(/bundle\.edit-/);
      expect(existsSync(ctx.bundleRef.current().themeCss)).toBe(true);
      await client.close();
    });

    it("rejects a path that traverses outside the bundle", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "delete_bundle_file", arguments: { path: "../evil.css" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("rejects an absolute path", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "delete_bundle_file", arguments: { path: "/etc/passwd" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("errors clearly on a missing file", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "delete_bundle_file", arguments: { path: "does-not-exist.css" } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/not found/);
      await client.close();
    });
  });

  describe("upload_bundle", () => {
    it("replaces the whole bundle via the same pipeline as PUT /api/bundle", async () => {
      const newTree = scratchDir("deckd-mcp-admin-new-bundle-");
      writeBundleTree(newTree, "v3");
      const zipBytes = zipDir(newTree);

      const client = await connectAdmin();
      const r = await client.callTool({ name: "upload_bundle", arguments: { data_base64: zipBytes.toString("base64") } });
      expect(r.isError).toBeFalsy();
      const summary = jsonOf(r as CallToolResult) as { manifest: { theme: string } };
      expect(summary.manifest.theme).toBe("theme.css");
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("v3");
      await client.close();
    });

    // Regression: upload_bundle and PUT /api/bundle both call installBundleZip
    // directly (bundle-upload.ts), so a Finder-style single-wrapper-folder zip that
    // PUT /api/bundle now accepts must be accepted here too.
    it("installs a bundle zipped as a single wrapper folder, same as PUT /api/bundle", async () => {
      const parent = scratchDir("deckd-mcp-admin-wrapper-parent-");
      const wrapperDir = join(parent, "my-bundle");
      writeBundleTree(wrapperDir, "wrapped-v4");
      const zipPath = join(scratchDir("deckd-mcp-admin-wrapper-out-"), "bundle.zip");
      execFileSync("zip", ["-r", zipPath, "my-bundle"], { cwd: parent });

      const client = await connectAdmin();
      const r = await client.callTool({
        name: "upload_bundle",
        arguments: { data_base64: readFileSync(zipPath).toString("base64") },
      });
      expect(r.isError).toBeFalsy();
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("wrapped-v4");
      expect(existsSync(join(ctx.bundleRef.current().dir, "my-bundle"))).toBe(false);
      await client.close();
    });

    it("rejects a bad zip, leaving the live bundle untouched", async () => {
      const badTree = scratchDir("deckd-mcp-admin-bad-bundle-");
      writeFileSync(join(badTree, "theme.css"), "/* bad */");
      writeFileSync(join(badTree, "run.sh"), "#!/bin/sh\n");
      writeFileSync(join(badTree, "deckd.json"), JSON.stringify({ theme: "theme.css" }));
      const zipBytes = zipDir(badTree);

      const client = await connectAdmin();
      const r = await client.callTool({ name: "upload_bundle", arguments: { data_base64: zipBytes.toString("base64") } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/run\.sh/);
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("v1");
      await client.close();
    });

    it("rejects a payload over the 40MB pre-decode cap without attempting to decode it", async () => {
      const client = await connectAdmin();
      // Sized so the approx-decoded-bytes check (data_base64.length * 3 / 4) trips
      // comfortably past MAX_MCP_BUNDLE_UPLOAD_BYTES, without needing valid zip bytes
      // -- the pre-decode check must reject this before ever calling Buffer.from/unzip.
      const tooLong = "A".repeat(Math.ceil((MAX_MCP_BUNDLE_UPLOAD_BYTES * 4) / 3) + 1024);
      const r = await client.callTool({ name: "upload_bundle", arguments: { data_base64: tooLong } });
      expect(r.isError).toBe(true);
      expect(textOf(r as CallToolResult)).toMatch(/too large/);
      await client.close();
    }, 30_000);

    it("round-trips: the actual GET /api/bundle/download zip re-uploads via upload_bundle unchanged", async () => {
      const dlRes = await request(ctx.app)
        .get("/api/bundle/download")
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(dlRes.status).toBe(200);
      const zipBytes = dlRes.body as Buffer;

      const client = await connectAdmin();
      const r = await client.callTool({ name: "upload_bundle", arguments: { data_base64: zipBytes.toString("base64") } });
      expect(r.isError).toBeFalsy();
      expect(readFileSync(ctx.bundleRef.current().themeCss, "utf8")).toContain("v1");
      expect(readFileSync(join(ctx.bundleRef.current().dir, "presentations", "example-deck", "slides.md"), "utf8")).toContain(
        "# Example",
      );
      await client.close();
    });
  });

  describe("download_bundle", () => {
    it("returns the download URL", async () => {
      const client = await connectAdmin();
      const r = await client.callTool({ name: "download_bundle", arguments: {} });
      expect(r.isError).toBeFalsy();
      const text = textOf(r as CallToolResult);
      expect(text).toContain("/api/bundle/download");
      expect(text).toMatch(/^http:\/\/127\.0\.0\.1:/);
      await client.close();
    });
  });
});
