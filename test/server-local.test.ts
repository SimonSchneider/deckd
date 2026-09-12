import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { DeckStore } from "../src/store.js";
import { DeckService } from "../src/decks.js";
import { RenderQueue, type RenderJob } from "../src/render.js";
import { makeBundle } from "./helpers.js";
import { createBundleRef } from "../src/bundle.js";
import type { Config } from "../src/config.js";
import type { Express } from "express";

let app: Express;
let store: DeckStore;
let jobsRun: RenderJob[];
let localDecksRoot: string;

beforeEach(() => {
  localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-test-local-"));
  const bundle = makeBundle();
  const cfg: Config = {
    port: 0, dbPath: ":memory:", devUser: "dev@example.com",
    bundleDir: "/tmp/deckd-test-bundle-unused", scratchDir: "/tmp/deckd-test-scratch-unused",
    canonicalCacheDir: mkdtempSync(join(tmpdir(), "deckd-test-cache-")), localDecksRoot,
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
  store = new DeckStore(":memory:");
  jobsRun = [];
  const renders = new RenderQueue(async (jobArg) => { jobsRun.push(jobArg); return { code: 0, output: "" }; });
  const bundleRef = createBundleRef(bundle);
  app = buildApp({ cfg, bundleRef, store, decks: new DeckService(store, cfg, bundleRef), renders });
});

describe("decks via the API", () => {
  it("POST /api/decks creates a plain directory deck", async () => {
    const r = await request(app).post("/api/decks").send({ name: "Local Deck" });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("local");
    expect(r.body.slug).toBe("local-deck");
    expect(existsSync(join(localDecksRoot, r.body.id, "presentations", "local-deck", "slides.md"))).toBe(true);
  });

  it("GET status returns render/decks info with no sandbox concepts", async () => {
    const created = await request(app).post("/api/decks").send({ name: "Status Deck" });
    const st = await request(app).get(`/api/decks/${created.body.id}`);
    expect(st.status).toBe(200);
    expect(st.body.deck.kind).toBe("local");
    expect(st.body.render).toEqual({ rendering: false, queued: false, last: null });
  });

  it("source read/write, render, assets and export all work end to end", async () => {
    const created = await request(app).post("/api/decks").send({ name: "Full Flow" });
    const id: string = created.body.id;

    const src = await request(app).get(`/api/decks/${id}/source`);
    expect(src.status).toBe(200);
    expect(src.body.content).toContain("# Full Flow");

    const put = await request(app).put(`/api/decks/${id}/source`)
      .send({ content: "# edited", baseMtime: src.body.mtime });
    expect(put.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsRun.at(-1)).toMatchObject({ slug: "full-flow" });

    const render = await request(app).post(`/api/decks/${id}/render`);
    expect(render.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsRun.at(-1)).toMatchObject({ slug: "full-flow" });

    const asset = await request(app).post(`/api/decks/${id}/assets?name=logo.png`)
      .set("content-type", "application/octet-stream").send(Buffer.from("png"));
    expect(asset.status).toBe(201);
    expect(existsSync(join(localDecksRoot, id, "presentations/full-flow/images/logo.png"))).toBe(true);

    const exp = await request(app).get(`/api/decks/${id}/export`);
    expect(exp.status).toBe(200);
  });

  it("DELETE removes the row and the on-disk directory", async () => {
    const created = await request(app).post("/api/decks").send({ name: "To Delete" });
    const id: string = created.body.id;
    const dir = join(localDecksRoot, id);
    expect(existsSync(dir)).toBe(true);
    const del = await request(app).delete(`/api/decks/${id}`);
    expect(del.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
  });

  it("every chat-shaped route 410s with a clear MCP pointer", async () => {
    const created = await request(app).post("/api/decks").send({ name: "No Agent" });
    const id: string = created.body.id;
    for (const call of [
      () => request(app).post(`/api/decks/${id}/chat`).send({ prompt: "hi" }),
      () => request(app).post(`/api/decks/${id}/chat/cancel`),
      () => request(app).get(`/api/decks/${id}/chat/history`),
      () => request(app).get(`/api/decks/${id}/events`),
    ]) {
      const r = await call();
      expect(r.status).toBe(410);
      expect(r.body.error).toMatch(/moved to MCP/);
    }
  });

  it("chat routes 404 for a deck that isn't the caller's own", async () => {
    const created = await request(app).post("/api/decks").send({ name: "Not Yours" });
    const id: string = created.body.id;
    const r = await request(app).post(`/api/decks/${id}/chat`).set("x-deckd-user", "evil@example.com").send({ prompt: "hi" });
    expect(r.status).toBe(404);
  });

  it("renders a deck that happens to carry a charts.py without special handling", async () => {
    const created = await request(app).post("/api/decks").send({ name: "Chartsy" });
    const id: string = created.body.id;
    const deckDir = join(localDecksRoot, id, "presentations/chartsy");
    // Nothing runs charts.py any more (no sandboxd); an imported deck that still
    // carries one must not fail the render on its account.
    writeFileSync(join(deckDir, "charts.py"), "print('never executed')");

    const r = await request(app).post(`/api/decks/${id}/render`);
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 0));
    expect(jobsRun.at(-1)).toMatchObject({ slug: "chartsy" });
    expect(readFileSync(deckDir + "/charts.py", "utf8")).toContain("never executed");
  });
});
