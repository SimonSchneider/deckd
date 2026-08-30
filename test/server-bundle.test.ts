import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { buildApp } from "../src/server.js";
import { SessionStore } from "../src/store.js";
import { SessionService } from "../src/sessions.js";
import { RenderQueue, createRenderRunner } from "../src/render.js";
import { createHostRenderer, type SpawnFn } from "../src/host-render.js";
import { createBundleRef, loadBundle } from "../src/bundle.js";
import type { Config } from "../src/config.js";

// A single stub standing in for the real marp binary: whatever "theme.css" resolves
// to in its cwd (the render's scratch dir -- see host-render.ts's ensureBundleLinks)
// is copied verbatim into the -o target, so a test can prove a render actually read
// the CURRENT bundle's theme content, not a cached or stale one, by reading the
// rendered "pdf" back.
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
  const zipPath = join(scratchDir("deckd-server-bundle-zip-"), "bundle.zip");
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

describe("PUT/GET /api/bundle", () => {
  let app: Express;
  let cfg: Config;

  beforeEach(() => {
    const dataDir = scratchDir("deckd-server-bundle-data-");
    cfg = {
      port: 0, dbPath: ":memory:", devUser: "dev@example.com",
      bundleDir: join(dataDir, "bundle"),
      scratchDir: join(dataDir, "render-scratch"),
      canonicalCacheDir: join(dataDir, "canonical-cache"),
      localSessionsRoot: join(dataDir, "local-sessions"),
      chromePath: "/tmp/deckd-test-chrome-unused",
    };
    writeBundleTree(cfg.bundleDir, "old-theme-v1");
    const bundleRef = createBundleRef(loadBundle(cfg.bundleDir));
    const store = new SessionStore(":memory:");
    const sessions = new SessionService(store, cfg, bundleRef);
    const marpPath = makeStubMarp(dataDir);
    const hostRenderer = createHostRenderer({
      bundleRef, scratchRoot: cfg.scratchDir, env: { PATH: process.env.PATH ?? "" },
      exec: makeExec(marpPath), marpBinPath: "stub-marp",
    });
    const renders = new RenderQueue(createRenderRunner(hostRenderer), 2);
    app = buildApp({ cfg, bundleRef, store, sessions, renders });
  });

  it("GET reflects the seeded bundle's manifest and counts", async () => {
    const r = await request(app).get("/api/bundle");
    expect(r.status).toBe(200);
    expect(r.body.manifest).toEqual({ theme: "theme.css", examples: "presentations" });
    expect(r.body.exampleCount).toBe(1);
    expect(r.body.fileCount).toBeGreaterThan(0);
    expect(r.body.uploadedAt).toBeGreaterThan(0);
  });

  it("GET /api/bundle/download returns a zip containing the current bundle's deckd.json", async () => {
    const res = await request(app)
      .get("/api/bundle/download")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/zip/);
    expect(res.headers["content-disposition"]).toContain("deckd-bundle.zip");

    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(Object.keys(zip.files)).toContain("deckd.json");
    expect(Object.keys(zip.files)).toContain("theme.css");
    const manifestEntry = zip.file("deckd.json");
    if (manifestEntry === null) throw new Error("zip has no deckd.json");
    const manifest = JSON.parse(await manifestEntry.async("text")) as { theme: string };
    expect(manifest.theme).toBe("theme.css");
  });

  it("rejects a bad upload with 400 and a clear message, leaving the bundle untouched", async () => {
    const badDir = scratchDir("deckd-server-bundle-bad-");
    writeFileSync(join(badDir, "run.sh"), "#!/bin/sh\n");
    writeFileSync(join(badDir, "theme.css"), "/* bad */");
    writeFileSync(join(badDir, "deckd.json"), JSON.stringify({ theme: "theme.css" }));

    const r = await request(app).put("/api/bundle").send(zipDir(badDir));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/run\.sh/);

    const summary = await request(app).get("/api/bundle");
    expect(summary.body.manifest).toEqual({ theme: "theme.css", examples: "presentations" });
  });

  it("swaps the live bundle with no restart, and a subsequent render of the same deck picks up the new theme", async () => {
    const created = await request(app).post("/api/sessions").send({ name: "d" });
    const sessionId: string = created.body.id;
    const slug: string = created.body.slug;

    const pdfPath = join(cfg.localSessionsRoot, sessionId, "presentations", slug, `${slug}.pdf`);

    await request(app).post(`/api/sessions/${sessionId}/render`).query({ deck: slug });
    await waitForRenderSettle(app, sessionId);
    expect(readFileSync(pdfPath, "utf8")).toContain("old-theme-v1");

    const newBundleTree = scratchDir("deckd-server-bundle-new-");
    writeBundleTree(newBundleTree, "new-theme-v2");
    const putRes = await request(app).put("/api/bundle").send(zipDir(newBundleTree));
    expect(putRes.status).toBe(200);
    expect(putRes.body.manifest.theme).toBe("theme.css");

    const getRes = await request(app).get("/api/bundle");
    expect(getRes.body.uploadedAt).toBeGreaterThanOrEqual(putRes.body.uploadedAt);

    await request(app).post(`/api/sessions/${sessionId}/render`).query({ deck: slug });
    await waitForRenderSettle(app, sessionId);
    const after = readFileSync(pdfPath, "utf8");
    expect(after).toContain("new-theme-v2");
    expect(after).not.toContain("old-theme-v1");
  });
});
