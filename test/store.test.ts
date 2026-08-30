import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, addKindColumn, assertDbPathNotAbandoningLegacy } from "../src/store.js";

function mk(): SessionStore { return new SessionStore(":memory:"); }
const base = { id: "s1", userEmail: "a@example.com", name: "My deck", slug: "my-deck", appId: "app1", sandboxId: "sb1" };

describe("SessionStore", () => {
  it("creates and gets a session", () => {
    const s = mk();
    const row = s.create(base);
    expect(row.createdAt).toBeGreaterThan(0);
    expect(s.get("s1")?.slug).toBe("my-deck");
    expect(s.get("nope")).toBeNull();
  });
  it("opens the db when its parent directory doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-store-missing-dir-"));
    const dbPath = join(dir, "nested", "sub", "deckd.sqlite3");
    const s = new SessionStore(dbPath);
    s.create(base);
    expect(s.get("s1")?.slug).toBe("my-deck");
  });
  it("defaults kind to sandbox, but honors an explicit kind", () => {
    const s = mk();
    s.create(base);
    expect(s.get("s1")?.kind).toBe("sandbox");
    s.create({ ...base, id: "s2", appId: "", sandboxId: "", kind: "local" });
    expect(s.get("s2")?.kind).toBe("local");
  });
  it("adds the kind column to a pre-existing DB that predates it, defaulting existing rows to sandbox", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "deckd-store-migrate-")), "deckd.sqlite3");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, userEmail TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      appId TEXT NOT NULL, sandboxId TEXT NOT NULL,
      createdAt INTEGER NOT NULL, touchedAt INTEGER NOT NULL, brokenReason TEXT
    )`);
    raw.prepare(
      `INSERT INTO sessions (id,userEmail,name,slug,appId,sandboxId,createdAt,touchedAt,brokenReason)
       VALUES ('old1','a@example.com','Old deck','old-deck','app1','sb1',1,1,NULL)`,
    ).run();
    raw.close();

    const s = new SessionStore(dbPath);
    expect(s.get("old1")?.kind).toBe("sandbox");
    // the store is usable afterwards, including for new local rows
    s.create({ id: "new1", userEmail: "a@example.com", name: "n", slug: "n", appId: "", sandboxId: "", kind: "local" });
    expect(s.get("new1")?.kind).toBe("local");
  });
  it("addKindColumn tolerates a duplicate-column race from a concurrent migration", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "deckd-store-migrate-race-")), "deckd.sqlite3");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, userEmail TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      appId TEXT NOT NULL, sandboxId TEXT NOT NULL,
      createdAt INTEGER NOT NULL, touchedAt INTEGER NOT NULL, brokenReason TEXT
    )`);
    addKindColumn(raw);
    // A second process's migration racing on the same on-disk table: its own ALTER
    // TABLE always throws "duplicate column name" here, since the column now exists.
    expect(() => addKindColumn(raw)).not.toThrow();
    raw.close();
  });
  it("lists only the user's local sessions, newest touched first", () => {
    const s = mk();
    s.create({ ...base, kind: "local" });
    s.create({ ...base, id: "s2", kind: "local" });
    s.create({ ...base, id: "s3", userEmail: "b@example.com", kind: "local" });
    const t = Date.now();
    while (Date.now() === t) {}
    s.touch("s1");
    expect(s.listForUser("a@example.com").map((r) => r.id)).toEqual(["s1", "s2"]);
  });
  it("excludes sandbox-kind rows from listForUser", () => {
    const s = mk();
    s.create(base); // defaults to kind "sandbox"
    s.create({ ...base, id: "s2", kind: "local" });
    expect(s.listForUser("a@example.com").map((r) => r.id)).toEqual(["s2"]);
  });
  it("listSandboxSessions returns every sandbox-kind row, across users", () => {
    const s = mk();
    s.create(base); // kind "sandbox"
    s.create({ ...base, id: "s2", userEmail: "b@example.com" }); // kind "sandbox"
    s.create({ ...base, id: "s3", kind: "local" });
    expect(s.listSandboxSessions().map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });
  it("markBroken and delete", () => {
    const s = mk();
    s.create(base);
    s.markBroken("s1", "wedged");
    expect(s.get("s1")?.brokenReason).toBe("wedged");
    s.delete("s1");
    expect(s.get("s1")).toBeNull();
  });
});

describe("assertDbPathNotAbandoningLegacy", () => {
  it("throws when the configured path is missing but the legacy path exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-legacy-db-"));
    const dbPath = join(dir, "data", "deckd.sqlite3");
    const legacyDbPath = join(dir, "deckd.sqlite3");
    writeFileSync(legacyDbPath, "not really sqlite, just needs to exist");

    expect(() => assertDbPathNotAbandoningLegacy(dbPath, legacyDbPath)).toThrow(/deckd\.sqlite3.*does not exist/);
    expect(() => assertDbPathNotAbandoningLegacy(dbPath, legacyDbPath)).toThrow(new RegExp(legacyDbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("does not throw when the configured path already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-legacy-db-"));
    const dbPath = join(dir, "deckd.sqlite3");
    const legacyDbPath = join(dir, "old", "deckd.sqlite3");
    writeFileSync(dbPath, "already there");

    expect(() => assertDbPathNotAbandoningLegacy(dbPath, legacyDbPath)).not.toThrow();
  });

  it("does not throw when the legacy path doesn't exist either (a genuinely fresh install)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-legacy-db-"));
    const dbPath = join(dir, "data", "deckd.sqlite3");
    const legacyDbPath = join(dir, "deckd.sqlite3");

    expect(() => assertDbPathNotAbandoningLegacy(dbPath, legacyDbPath)).not.toThrow();
  });

  it("does not throw when the configured path IS the legacy path (DECKD_DB points straight at it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deckd-legacy-db-"));
    const legacyDbPath = join(dir, "deckd.sqlite3");
    writeFileSync(legacyDbPath, "the actual db");

    expect(() => assertDbPathNotAbandoningLegacy(legacyDbPath, legacyDbPath)).not.toThrow();
  });
});
