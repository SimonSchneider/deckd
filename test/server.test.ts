import { describe, it, expect } from "vitest";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";
import { SessionStore } from "../src/store.js";
import { SessionService } from "../src/sessions.js";
import { RenderQueue } from "../src/render.js";
import { makeBundle } from "./helpers.js";
import type { Config } from "../src/config.js";
import { createBundleRef, type Bundle } from "../src/bundle.js";
import { deckPaths } from "../src/artifacts.js";

function build(bundle: Bundle = makeBundle()) {
  const cfg: Config = {
    port: 0, dbPath: ":memory:", devUser: "dev@example.com",
    bundleDir: "/tmp/deckd-test-bundle-unused", scratchDir: "/tmp/deckd-test-scratch-unused",
    canonicalCacheDir: mkdtempSync(join(tmpdir(), "deckd-test-cache-")),
    localSessionsRoot: mkdtempSync(join(tmpdir(), "deckd-test-local-")),
    chromePath: "/tmp/deckd-test-chrome-unused",
  };
  const store = new SessionStore(":memory:");
  const bundleRef = createBundleRef(bundle);
  const sessions = new SessionService(store, cfg, bundleRef);
  const renders = new RenderQueue(async () => ({ code: 0, output: "" }), 2);
  return { app: buildApp({ cfg, bundleRef, store, sessions, renders }), store, cfg };
}

describe("api", () => {
  it("GET /api/me uses the dev user", async () => {
    const { app } = build();
    const r = await request(app).get("/api/me");
    expect(r.status).toBe(200);
    expect(r.body.email).toBe("dev@example.com");
  });
  it("session status + pdf serving with ownership check", async () => {
    const { app, cfg } = build(makeBundle());
    const created = await request(app).post("/api/sessions").send({ name: "d" });
    const id: string = created.body.id;
    const slug: string = created.body.slug;
    writeFileSync(join(cfg.localSessionsRoot, id, "presentations", slug, `${slug}.pdf`), "%PDF-fake");
    const st = await request(app).get(`/api/sessions/${id}`);
    expect(st.status).toBe(200);
    expect(st.body.decks).toContain("template-gallery");
    expect(st.body.pdfMtime).toBeGreaterThan(0);
    const pdf = await request(app).get(`/api/sessions/${id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const other = await request(app).get(`/api/sessions/${id}/pdf`).set("x-deckd-user", "evil@example.com");
    expect(other.status).toBe(404);
  });
  it("lists only the session's own deck when the bundle declares no examples", async () => {
    const { app } = build(makeBundle({ examples: false }));
    const created = await request(app).post("/api/sessions").send({ name: "d" });
    const st = await request(app).get(`/api/sessions/${created.body.id}`);
    expect(st.status).toBe(200);
    expect(st.body.decks).toEqual([created.body.slug]);
  });
  it("POST /api/sessions creates a local session via the service", async () => {
    const { app } = build(makeBundle());
    const r = await request(app).post("/api/sessions").send({ name: "New Deck" });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe("new-deck");
    expect(r.body.kind).toBe("local");
  });
  it("POST /api/sessions/import accepts a zip with no content-type header", async () => {
    const { app, cfg } = build(makeBundle());
    const scratch = mkdtempSync(join(tmpdir(), "deckd-import-src-"));
    writeFileSync(join(scratch, "slides.md"), "---\nmarp: true\n---\n\n# Imported\n");
    const zipPath = join(scratch, "deck.zip");
    execFileSync("zip", ["-r", zipPath, "slides.md"], { cwd: scratch });
    const zipBuffer = readFileSync(zipPath);
    const before = new Set(readdirSync(tmpdir()).filter((n) => /^deckd-import-[^-]+$/.test(n)));
    // .send(Buffer) leaves Content-Type unset (superagent treats Buffers as a
    // "host object" and skips its default-json header logic) — this is the
    // regression case: a header-less upload must still bind as raw bytes.
    const r = await request(app).post("/api/sessions/import").query({ name: "Imported" }).send(zipBuffer);
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe("imported");
    expect(existsSync(join(cfg.localSessionsRoot, r.body.id, "presentations/imported/slides.md"))).toBe(true);
    // the tmp dir holding the uploaded zip is removed once session creation settles
    const leftover = readdirSync(tmpdir()).filter((n) => /^deckd-import-[^-]+$/.test(n) && !before.has(n));
    expect(leftover).toEqual([]);
  });
  it("POST /api/sessions/import rejects missing name or empty body", async () => {
    const { app } = build();
    const noName = await request(app).post("/api/sessions/import").send(Buffer.from("x"));
    expect(noName.status).toBe(400);
    const emptyBody = await request(app).post("/api/sessions/import").query({ name: "Imported" }).send(Buffer.alloc(0));
    expect(emptyBody.status).toBe(400);
  });
});

// A bundle example is viewable with no session at all -- these mirror the
// session-scoped ?deck= routes for a non-own deck (see the "session status +
// pdf serving" test above), but need no session to exist first.
describe("sessionless example routes", () => {
  it("GET /api/examples lists the bundle's example slugs, or [] with none declared", async () => {
    const { app } = build(makeBundle());
    const r = await request(app).get("/api/examples");
    expect(r.status).toBe(200);
    expect(r.body.examples).toEqual(["template-gallery"]);

    const { app: noExamplesApp } = build(makeBundle({ examples: false }));
    const none = await request(noExamplesApp).get("/api/examples");
    expect(none.status).toBe(200);
    expect(none.body.examples).toEqual([]);
  });

  it("GET /api/examples/:slug/source returns read-only content + mtime", async () => {
    const { app } = build(makeBundle());
    const r = await request(app).get("/api/examples/template-gallery/source");
    expect(r.status).toBe(200);
    expect(r.body.content).toContain("# Template gallery");
    expect(typeof r.body.mtime).toBe("number");
  });

  it("render + status + pdf serving for an example, with no session involved", async () => {
    const { app, cfg } = build(makeBundle());
    const render = await request(app).post("/api/examples/template-gallery/render");
    expect(render.status).toBe(202);
    expect(render.body.queued).toBe("template-gallery");

    // The render itself is faked (see build()'s RenderQueue), so drop the
    // rendered PDF into the canonical cache the same way the fake render would --
    // syncCanonicalDeckCache (already run synchronously by the route above) has
    // created the cache dir by now.
    writeFileSync(deckPaths(cfg.canonicalCacheDir, "template-gallery").pdf, "%PDF-fake");

    const status = await request(app).get("/api/examples/template-gallery");
    expect(status.status).toBe(200);
    expect(status.body.pdfMtime).toBeGreaterThan(0);
    expect(typeof status.body.sourceMtime).toBe("number");

    const pdf = await request(app).get("/api/examples/template-gallery/pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
  });

  it("400s a malformed slug, 404s an unknown one, across the example routes", async () => {
    const { app } = build(makeBundle());
    const badSlug = await request(app).get("/api/examples/Not_A_Slug/source");
    expect(badSlug.status).toBe(400);

    const unknownSource = await request(app).get("/api/examples/nope/source");
    expect(unknownSource.status).toBe(404);
    const unknownStatus = await request(app).get("/api/examples/nope");
    expect(unknownStatus.status).toBe(404);
    const unknownRender = await request(app).post("/api/examples/nope/render");
    expect(unknownRender.status).toBe(404);
    const unknownPdf = await request(app).get("/api/examples/nope/pdf");
    expect(unknownPdf.status).toBe(404);
  });
});
