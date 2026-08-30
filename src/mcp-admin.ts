import { existsSync, lstatSync, statSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { readBundleManifest, resolveBundlePath, type BundleRef, type BundleWriter } from "./bundle.js";
import { installBundleZip, applyBundleEdit, bundleSummary, BUNDLE_CONTENT_EXTENSIONS, MAX_BUNDLE_FILE_BYTES } from "./bundle-upload.js";

export interface McpAdminDeps {
  cfg: Config;
  // The full read+write handle, unlike mcp.ts's McpDeps (deck-editing MCP has no
  // bundle tools at all): every tool below either reads bundleRef.current() or
  // replaces it via installBundleZip/applyBundleEdit.
  bundleRef: BundleRef & BundleWriter;
}

const SERVER_NAME = "deckd-admin";
const SERVER_VERSION = "1.0.0";

const SERVER_INSTRUCTIONS = [
  "deckd-admin manages the live content bundle (theme, assets, example decks, guide) that every",
  "deckd render uses. A change here applies immediately to every session's next render, with no",
  "restart and no review step, and there is no version history -- read a file with",
  "read_bundle_file before overwriting or deleting it if you want to be able to restore it by hand.",
  "Call get_bundle_info first to see the manifest and the full file listing.",
  "write_bundle_file and delete_bundle_file validate the whole resulting bundle before applying a",
  "change (content allowlist, size caps, and that the manifest still resolves); a change that would",
  "break it -- deleting the active theme, or editing deckd.json to point at a file that doesn't",
  "exist -- is rejected and the live bundle is left completely unchanged.",
  "This endpoint has no authentication: anyone who can reach it can rewrite the live bundle. It is",
  "meant for a trusted local admin client only -- never expose it beyond localhost.",
].join(" ");

// Independent of MAX_BUNDLE_FILE_BYTES (the cap a file must already be under to live
// in the bundle at all): a read is a single JSON-RPC response the caller waits on, so
// it gets its own, tighter bound -- matching the pattern MAX_MCP_ASSET_BYTES sets in
// mcp.ts for the same reason.
const MAX_ADMIN_READ_BYTES = 5 * 1024 * 1024;

// A bundle upload over MCP is a single JSON-RPC request body (base64-encoded, ~4/3
// the decoded size) rather than a raw HTTP PUT, so it gets its own, smaller cap than
// PUT /api/bundle's 100MB -- generous for a real bundle (theme + assets + a handful
// of example decks) while keeping a single MCP request body bounded. Exported so a
// test can compute a payload guaranteed to trip it without allocating anywhere near
// the real cap.
export const MAX_MCP_BUNDLE_UPLOAD_BYTES = 40 * 1024 * 1024;

// The text/binary split for read_bundle_file, derived from BUNDLE_CONTENT_EXTENSIONS
// (the same allowlist write_bundle_file and bundle upload enforce) rather than stated
// independently, so read_bundle_file can never drift out of sync with what the bundle
// is actually allowed to contain.
const ADMIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["css", "md", "markdown", "json", "txt", "svg"]);
const ADMIN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  [...BUNDLE_CONTENT_EXTENSIONS].filter((ext) => !ADMIN_TEXT_EXTENSIONS.has(ext)),
);

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

// Same rationale as mcp.ts's identical wrapper: a thrown error would otherwise
// surface as a JSON-RPC protocol-level error, which most MCP clients show far less
// usefully than a normal tool result with isError.
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

interface BundleFileInfo {
  path: string;
  size: number;
  mtime: number;
}

// Recursively lists every file under a bundle dir (deckd.json included) for
// get_bundle_info. Symlinks are skipped rather than followed -- a live bundle
// should never contain one (installBundleZip/applyBundleEdit both strip or refuse
// them before swap), but this stays defensive rather than assuming that invariant.
function listBundleFiles(dir: string): BundleFileInfo[] {
  const out: BundleFileInfo[] = [];
  function walk(cur: string, rel: string): void {
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      const relPath = rel === "" ? entry : `${rel}/${entry}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      out.push({ path: relPath, size: st.size, mtime: st.mtimeMs });
    }
  }
  walk(dir, "");
  return out;
}

function registerAdminTools(server: McpServer, deps: McpAdminDeps): void {
  server.registerTool(
    "get_bundle_info",
    { description: "Read the live bundle's manifest (deckd.json) and a recursive listing of every file it contains (path, size, mtime)." },
    wrap(async () => {
      const bundle = deps.bundleRef.current();
      return jsonResult({ manifest: readBundleManifest(bundle.dir), files: listBundleFiles(bundle.dir) });
    }),
  );

  server.registerTool(
    "read_bundle_file",
    {
      description:
        "Read one file from the live bundle by its path relative to the bundle root, capped at 5MB. " +
        "Text files (css, md, markdown, json, txt, svg) come back as UTF-8 text; binary files (fonts, " +
        "png/jpg/webp/gif) come back base64-encoded.",
      inputSchema: { path: z.string().describe('Path relative to the bundle root, e.g. "theme.css" or "assets/logo.svg".') },
    },
    wrap(async ({ path }) => {
      const bundle = deps.bundleRef.current();
      const abs = resolveBundlePath(bundle.dir, "path", path);
      if (!existsSync(abs) || lstatSync(abs).isDirectory()) throw new Error(`bundle file not found: ${path}`);
      const st = statSync(abs);
      // Applies to both branches below: a read is a single JSON-RPC response, so a
      // multi-MB text file (a large guide, say) is just as unbounded a payload as a
      // multi-MB binary one if this only gated the binary branch.
      if (st.size > MAX_ADMIN_READ_BYTES) {
        throw new Error(`bundle file too large to read: ${path} is ${st.size} bytes (max ${MAX_ADMIN_READ_BYTES})`);
      }
      const ext = extname(path).slice(1).toLowerCase();
      if (ADMIN_TEXT_EXTENSIONS.has(ext)) {
        return jsonResult({ path, mtime: st.mtimeMs, encoding: "utf8", content: readFileSync(abs, "utf8") });
      }
      if (ADMIN_BINARY_EXTENSIONS.has(ext)) {
        return jsonResult({ path, mtime: st.mtimeMs, size: st.size, encoding: "base64", data_base64: readFileSync(abs).toString("base64") });
      }
      throw new Error(`unsupported file extension for read_bundle_file: ${path}`);
    }),
  );

  server.registerTool(
    "write_bundle_file",
    {
      description:
        "Write one file into the live bundle (creating or overwriting it), by path relative to the " +
        "bundle root -- including deckd.json itself, to change the manifest. Pass exactly one of " +
        "content (UTF-8 text) or data_base64 (binary). The write is validated against the whole " +
        "bundle (content allowlist, size caps, manifest still resolves) before it takes effect; a " +
        "change that would break the bundle is rejected and the live bundle is left unchanged. Pass " +
        "base_mtime (from a prior read_bundle_file/write_bundle_file call) to fail instead of " +
        "clobbering a file changed since you last read it.",
      inputSchema: {
        path: z.string().describe('Path relative to the bundle root, e.g. "theme.css" or "assets/logo.svg".'),
        content: z.string().optional().describe("UTF-8 text content. Exactly one of content/data_base64 is required."),
        data_base64: z.string().optional().describe("Base64-encoded binary content. Exactly one of content/data_base64 is required."),
        base_mtime: z.number().optional().describe("mtime (ms) this write is based on, for the conflict check, if the file already exists."),
      },
    },
    wrap(async ({ path, content, data_base64, base_mtime }) => {
      if ((content === undefined) === (data_base64 === undefined)) {
        throw new Error("exactly one of content or data_base64 is required");
      }
      const bundle = deps.bundleRef.current();
      const abs = resolveBundlePath(bundle.dir, "path", path);
      if (existsSync(abs) && lstatSync(abs).isDirectory()) throw new Error(`path is a directory, not a file: ${path}`);
      const ext = extname(path).slice(1).toLowerCase();
      if (!BUNDLE_CONTENT_EXTENSIONS.has(ext)) {
        throw new Error(`bundle file extension not allowed: ${path} (extension "${ext === "" ? "<none>" : `.${ext}`}" is not on the content allowlist)`);
      }

      const currentMtime = existsSync(abs) ? statSync(abs).mtimeMs : null;
      // >1ms tolerance absorbs filesystem mtime rounding, matching every other
      // base_mtime conflict check in this codebase (write_slides, PUT /source).
      if (base_mtime !== undefined && currentMtime !== null && Math.abs(currentMtime - base_mtime) > 1) {
        return jsonErrorResult({ error: "modified on disk", path, mtime: currentMtime });
      }

      let data: Buffer;
      if (data_base64 !== undefined) {
        // Base64 runs ~4/3 the size of the bytes it decodes to, so a payload already
        // over the cap is rejected from its encoded length alone, before paying for
        // the decode -- same approximation upload_asset (mcp.ts) uses. The decoded
        // check right after remains authoritative.
        const approxBytes = (data_base64.length * 3) / 4;
        if (approxBytes > MAX_BUNDLE_FILE_BYTES) {
          throw new Error(`bundle file too large: ~${Math.round(approxBytes)} bytes (max ${MAX_BUNDLE_FILE_BYTES})`);
        }
        data = Buffer.from(data_base64, "base64");
      } else {
        data = Buffer.from(content ?? "", "utf8");
      }
      if (data.length > MAX_BUNDLE_FILE_BYTES) {
        throw new Error(`bundle file too large: ${data.length} bytes (max ${MAX_BUNDLE_FILE_BYTES})`);
      }

      const outcome = await applyBundleEdit(deps.cfg, deps.bundleRef, (stagingDir) => {
        const dest = join(stagingDir, path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
      });
      const newMtime = statSync(join(outcome.bundle.dir, path)).mtimeMs;
      return jsonResult({ path, mtime: newMtime, bundle: outcome.summary });
    }),
  );

  server.registerTool(
    "delete_bundle_file",
    {
      description:
        "Delete one file from the live bundle, by path relative to the bundle root. Validated the " +
        "same way as write_bundle_file: deleting a file the manifest still refers to (e.g. the active " +
        "theme) is rejected, naming the manifest key it broke, and the live bundle is left unchanged.",
      inputSchema: { path: z.string().describe('Path relative to the bundle root, e.g. "assets/old-logo.svg".') },
    },
    wrap(async ({ path }) => {
      const bundle = deps.bundleRef.current();
      const abs = resolveBundlePath(bundle.dir, "path", path);
      if (!existsSync(abs)) throw new Error(`bundle file not found: ${path}`);
      if (lstatSync(abs).isDirectory()) throw new Error(`path is a directory, not a file: ${path}`);

      const outcome = await applyBundleEdit(deps.cfg, deps.bundleRef, (stagingDir) => {
        rmSync(join(stagingDir, path), { force: true });
      });
      return jsonResult({ path, deleted: true, bundle: outcome.summary });
    }),
  );

  server.registerTool(
    "upload_bundle",
    {
      description:
        "Replace the entire live bundle from a zip (the same validated pipeline as PUT /api/bundle: " +
        "manifest well-formed, theme resolves, content allowlist, size caps, no symlinks). Prefer " +
        "write_bundle_file/delete_bundle_file for a small change -- this replaces everything.",
      inputSchema: { data_base64: z.string().describe("Base64-encoded bundle zip, max 40MB decoded.") },
    },
    wrap(async ({ data_base64 }) => {
      const approxBytes = (data_base64.length * 3) / 4;
      if (approxBytes > MAX_MCP_BUNDLE_UPLOAD_BYTES) {
        throw new Error(`bundle upload too large: ~${Math.round(approxBytes)} bytes (max ${MAX_MCP_BUNDLE_UPLOAD_BYTES})`);
      }
      const data = Buffer.from(data_base64, "base64");
      const { summary } = await installBundleZip(data, deps.cfg, deps.bundleRef, (m) => console.log(m));
      return jsonResult(summary);
    }),
  );

  server.registerTool(
    "download_bundle",
    { description: "Get the download URL for a zip of the current live bundle." },
    wrap(async () => textResult(`http://127.0.0.1:${deps.cfg.port}/api/bundle/download`)),
  );
}

function methodNotAllowed(res: Response): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
  );
}

// Mounts the admin MCP endpoint on the given app at POST/GET/DELETE /mcp-admin,
// separate from the deck-editing /mcp (mcp.ts): the deck-editing endpoint keeps no
// bundle-management tools at all, so an AI client with only /mcp cannot touch the
// live bundle. Same stateless StreamableHTTPServerTransport pattern as mountMcp (a
// fresh McpServer + transport per request; no cross-request MCP session state), for
// the same reason: this is a local, no-auth trial. Unauthenticated by design for
// this phase -- a later phase gates it behind auth before this could ever be
// exposed beyond localhost.
export function mountMcpAdmin(app: Express, deps: McpAdminDeps): void {
  // Scoped to /mcp-admin and registered before buildApp's global json() parser
  // mounts, same reasoning as mountMcp's own larger limit: upload_bundle's
  // base64-encoded payload runs well above the app's global 2mb limit.
  app.use("/mcp-admin", express.json({ limit: "60mb" }));

  function getServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
    registerAdminTools(server, deps);
    return server;
  }

  app.post("/mcp-admin", async (req: Request, res: Response) => {
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

  app.get("/mcp-admin", (_req: Request, res: Response) => methodNotAllowed(res));
  app.delete("/mcp-admin", (_req: Request, res: Response) => methodNotAllowed(res));
}
