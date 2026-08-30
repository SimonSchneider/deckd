// node:sqlite is still flagged experimental (emits an ExperimentalWarning on
// startup), but has been usable with no CLI flag since Node 23.4, and this repo
// pins a Node version (see .nvmrc) well past that -- stable enough in practice to
// replace better-sqlite3, a native addon that needs a prebuilt binary per
// platform/Node ABI.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

// "sandbox" is a sandboxd-backed session (app clone + container); "local" is a
// plain directory on disk with no sandboxd involvement at all (BYOAI/MCP path).
export type SessionKind = "sandbox" | "local";

// Exported for index.ts's startup check and for direct testing. dbPath moved from
// the cwd-relative "./deckd.sqlite3" to "<dataDir>/deckd.sqlite3" (see config.ts);
// DatabaseSync creates a missing dbPath from scratch, so a deployment that
// restarts onto the new default without first moving its data would silently open
// an empty db instead of failing -- indistinguishable from "deckd forgot every
// session" until someone notices. Only refuses to start when the legacy file is
// still there and the new path isn't: a genuinely fresh install has neither, and
// that's fine.
export function assertDbPathNotAbandoningLegacy(dbPath: string, legacyDbPath: string): void {
  if (dbPath === legacyDbPath) return;
  if (existsSync(dbPath)) return;
  if (!existsSync(legacyDbPath)) return;
  throw new Error(
    `deckd: configured db "${dbPath}" does not exist, but the pre-pivot db "${legacyDbPath}" does. ` +
      `Move it to "${dbPath}", or set DECKD_DB="${legacyDbPath}", before starting deckd.`,
  );
}

export interface SessionRow {
  id: string; userEmail: string; name: string; slug: string;
  appId: string; sandboxId: string; kind: SessionKind; createdAt: number; touchedAt: number;
  brokenReason: string | null;
}

// Exported so a race can be exercised directly: two deckd processes opening the same
// on-disk DB can both see "kind" missing before either one's ALTER TABLE runs, and the
// loser's ALTER then fails with "duplicate column name" even though the column is
// exactly what it wanted. That failure is safe to swallow -- the column exists either
// way -- so only that specific SQLite error is caught; anything else still throws.
export function addKindColumn(db: DatabaseSync): void {
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'sandbox'");
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes("duplicate column name")) throw e;
  }
}

export class SessionStore {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, userEmail TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      appId TEXT NOT NULL, sandboxId TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sandbox',
      createdAt INTEGER NOT NULL, touchedAt INTEGER NOT NULL, brokenReason TEXT
    )`);
    this.migrateKindColumn();
  }
  // CREATE TABLE IF NOT EXISTS above is a no-op against a pre-existing DB from before
  // "kind" existed, so a fresh column with its DEFAULT is added by hand; SQLite
  // backfills every existing row with the default when the ADD COLUMN has one, which
  // is what turns pre-migration rows into "sandbox" sessions.
  private migrateKindColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "kind")) addKindColumn(this.db);
  }
  create(r: Pick<SessionRow, "id" | "userEmail" | "name" | "slug" | "appId" | "sandboxId"> & { kind?: SessionKind }): SessionRow {
    const now = Date.now();
    const kind = r.kind ?? "sandbox";
    this.db.prepare(
      `INSERT INTO sessions (id,userEmail,name,slug,appId,sandboxId,kind,createdAt,touchedAt,brokenReason)
       VALUES (@id,@userEmail,@name,@slug,@appId,@sandboxId,@kind,@createdAt,@touchedAt,NULL)`,
    ).run({
      id: r.id, userEmail: r.userEmail, name: r.name, slug: r.slug, appId: r.appId, sandboxId: r.sandboxId,
      kind, createdAt: now, touchedAt: now,
    });
    const row = this.get(r.id);
    if (row === null) throw new Error("insert failed");
    return row;
  }
  get(id: string): SessionRow | null {
    const row: unknown = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row === undefined ? null : (row as SessionRow);
  }
  // Only "local" rows: a "sandbox" row is a pre-migration leftover the app no
  // longer knows how to serve (see index.ts's startup check), so it is excluded
  // here rather than surfaced to a client that has nowhere to render it from.
  listForUser(email: string): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE userEmail = ? AND kind = 'local' ORDER BY touchedAt DESC").all(email) as unknown as SessionRow[];
  }
  // Every "sandbox"-kind row, across all users -- for the startup check that warns
  // about pre-migration sessions the app will not serve (see index.ts).
  listSandboxSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE kind = 'sandbox'").all() as unknown as SessionRow[];
  }
  touch(id: string): void {
    this.db.prepare("UPDATE sessions SET touchedAt = ? WHERE id = ?").run(Date.now(), id);
  }
  markBroken(id: string, reason: string): void {
    this.db.prepare("UPDATE sessions SET brokenReason = ? WHERE id = ?").run(reason, id);
  }
  delete(id: string): void { this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id); }
}
