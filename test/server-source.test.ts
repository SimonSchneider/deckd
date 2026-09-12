import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { DeckStore } from "../src/store.js";
import { DeckService } from "../src/decks.js";
import { RenderQueue, type RenderJob } from "../src/render.js";
import { makeBundle } from "./helpers.js";
import { createBundleRef } from "../src/bundle.js";
import { deckPaths } from "../src/artifacts.js";
import type { Config } from "../src/config.js";
import type { Express } from "express";

let app: Express;
let store: DeckStore;
let jobsRun: RenderJob[];
let appDir: string;
let deckId: string;
let devUser: string;

beforeEach(async () => {
  const bundle = makeBundle();
  const localDecksRoot = mkdtempSync(join(tmpdir(), "deckd-test-local-"));
  devUser = "dev@example.com";
  const cfg: Config = {
    port: 0, dbPath: ":memory:", devUser,
    bundleDir: "/tmp/deckd-test-bundle-unused", scratchDir: "/tmp/deckd-test-scratch-unused",
    canonicalCacheDir: "/tmp/deckd-test-cache-unused",
    localDecksRoot,
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
  store = new DeckStore(":memory:");
  jobsRun = [];
  const renders = new RenderQueue(async (job) => { jobsRun.push(job); return { code: 0, output: "" }; });
  const bundleRef = createBundleRef(bundle);
  app = buildApp({ cfg, bundleRef, store, decks: new DeckService(store, cfg, bundleRef), renders });
  const created = await request(app).post("/api/decks").send({ name: "d" });
  deckId = created.body.id;
  appDir = join(localDecksRoot, deckId);
});

describe("deck source routes", () => {
  it("GET returns content + mtime; an unknown deck 404s", async () => {
    const r = await request(app).get(`/api/decks/${deckId}/source`);
    expect(r.status).toBe(200);
    expect(r.body.content).toContain("# d");
    expect(typeof r.body.mtime).toBe("number");
    const bad = await request(app).get(`/api/decks/${deckId}/source?example=nope`);
    expect(bad.status).toBe(404);
  });

  it("PUT saves content, enqueues a render for the deck's own slides, and returns the new mtime", async () => {
    const before = await request(app).get(`/api/decks/${deckId}/source`);
    const r = await request(app).put(`/api/decks/${deckId}/source`).send({ content: "# hello", baseMtime: before.body.mtime });
    expect(r.status).toBe(200);
    expect(typeof r.body.mtime).toBe("number");
    expect(r.body.mtime).toBeGreaterThanOrEqual(before.body.mtime);
    expect(readFileSync(deckPaths(appDir, "d").slides, "utf8")).toBe("# hello");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobsRun[0]).toMatchObject({ slug: "d" });
  });

  it("PUT with a stale baseMtime 409s with the fresh on-disk content instead of writing", async () => {
    const p = deckPaths(appDir, "d");
    writeFileSync(p.slides, "# changed on disk");
    const r = await request(app).put(`/api/decks/${deckId}/source`).send({ content: "# my edit", baseMtime: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("modified on disk");
    expect(r.body.content).toBe("# changed on disk");
    expect(typeof r.body.mtime).toBe("number");
    expect(readFileSync(p.slides, "utf8")).toBe("# changed on disk");
    expect(jobsRun.length).toBe(0);
  });

  it("enforces ownership on both GET and PUT", async () => {
    const getOther = await request(app).get(`/api/decks/${deckId}/source`).set("x-deckd-user", "evil@example.com");
    expect(getOther.status).toBe(404);
    const putOther = await request(app).put(`/api/decks/${deckId}/source`).set("x-deckd-user", "evil@example.com")
      .send({ content: "x", baseMtime: 1 });
    expect(putOther.status).toBe(404);
  });

  it("GET /api/decks/:id includes sourceMtime for the selected deck", async () => {
    const r = await request(app).get(`/api/decks/${deckId}?example=d`);
    expect(r.status).toBe(200);
    expect(typeof r.body.sourceMtime).toBe("number");
  });

  // A pre-migration "sandbox"-kind row (see store.ts's kind column) has no
  // directory this app can serve a source route from, so ownedDeck treats it
  // as not found rather than a 500 --
  // this row is a leftover the fixture creates directly, not something the app
  // itself can produce any more.
  it("GET /source 404s for a pre-migration sandbox-kind row", async () => {
    const sandboxRow = store.create({
      id: "sandbox-row-1", userEmail: devUser, name: "old", slug: "old",
      appId: "app-1", sandboxId: "sb-1", kind: "sandbox",
    });
    const r = await request(app).get(`/api/decks/${sandboxRow.id}/source`);
    expect(r.status).toBe(404);
  });
});
