import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { joinCommands } from "../src/server/setup-kit/join-command";
import { joinCommandLines, JoinTokenError, parseJoinTokenArgs, runJoinToken } from "./join-token.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-join-token-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
let n = 0;

/** Slice of the panel schema the command touches. */
function panelDb({ withTable = true, panelUrl = "https://painel.exemplo.com" } = {}) {
  const db = new DatabaseSync(path.join(sandbox, `panel-${(n += 1)}.db`));
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL)");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO users VALUES ('admin-1', 'admin', '2026-01-01')").run();
  db.prepare("INSERT INTO settings VALUES ('settings', ?)").run(JSON.stringify({ panelPublicUrl: panelUrl }));
  if (withTable) {
    db.exec(`CREATE TABLE join_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER)`);
  }
  return db;
}

describe("parseJoinTokenArgs", () => {
  it("parses rotate with ttl and max uses", () => {
    expect(parseJoinTokenArgs([])).toEqual({ rotate: false, disable: false, ttlHours: null, maxUses: null });
    expect(parseJoinTokenArgs(["--rotate", "--ttl", "24h", "--max-uses", "3"])).toEqual({ rotate: true, disable: false, ttlHours: 24, maxUses: 3 });
  });

  it("rejects bad combinations and values", () => {
    expect(() => parseJoinTokenArgs(["--ttl", "2h"])).toThrow(JoinTokenError);
    expect(() => parseJoinTokenArgs(["--rotate", "--disable"])).toThrow(JoinTokenError);
    expect(() => parseJoinTokenArgs(["--rotate", "--ttl", "0h"])).toThrow(JoinTokenError);
    expect(() => parseJoinTokenArgs(["--rotate", "--max-uses", "x"])).toThrow(JoinTokenError);
    expect(() => parseJoinTokenArgs(["--show"])).toThrow(JoinTokenError);
  });
});

describe("runJoinToken", () => {
  it("rotate prints the token once, stores only its hash and revokes the previous one", () => {
    const db = panelDb();
    const first = runJoinToken(db, parseJoinTokenArgs(["--rotate"]), { version: "1.0.0", now: 1000 });
    const second = runJoinToken(db, parseJoinTokenArgs(["--rotate", "--max-uses", "2"]), { version: "1.0.0", now: 2000 });
    expect(second.token).toMatch(/^cjt_[A-Za-z0-9_-]{43}$/);
    expect(second.lines.join("\n")).toContain(`npx carbon join 'https://painel.exemplo.com' --token '${second.token}'`);
    const rows = db.prepare("SELECT token_hash, revoked_at, max_uses FROM join_tokens ORDER BY created_at").all();
    expect(rows[0].revoked_at).toBe(2000);
    expect(rows[1]).toMatchObject({ token_hash: createHash("sha256").update(second.token).digest("hex"), revoked_at: null, max_uses: 2 });
    expect(JSON.stringify(rows)).not.toContain(first.token);
  });

  it("status never shows the token; disable turns joining off", () => {
    const db = panelDb();
    runJoinToken(db, parseJoinTokenArgs(["--rotate"]), { version: "1.0.0", now: 1000 });
    const status = runJoinToken(db, parseJoinTokenArgs([]), { version: "1.0.0", now: 1500 });
    expect(status.token).toBeNull();
    expect(status.lines[0]).toContain("sem validade");
    runJoinToken(db, parseJoinTokenArgs(["--disable"]), { version: "1.0.0", now: 1600 });
    expect(runJoinToken(db, parseJoinTokenArgs([]), { version: "1.0.0", now: 1700 }).lines[0]).toContain("nenhum token de join ativo");
  });

  it("warns when the panel has no public URL, and fails before the migration", () => {
    const noUrl = runJoinToken(panelDb({ panelUrl: "" }), parseJoinTokenArgs(["--rotate"]), { version: "1.0.0" });
    expect(noUrl.lines.join("\n")).toContain("https://<url-pública-do-painel>");
    expect(noUrl.lines.join("\n")).toContain("não tem URL pública");
    expect(() => runJoinToken(panelDb({ withTable: false }), parseJoinTokenArgs([]), { version: "1.0.0" })).toThrow(/carbon start/);
  });

  it("prints the same commands as the panel UI", () => {
    const token = `cjt_${"A".repeat(43)}`;
    expect(joinCommandLines("https://p.test", token, "carbon-worker:1.0.0")).toEqual(joinCommands({ panelUrl: "https://p.test", token, image: "carbon-worker:1.0.0" }));
    expect(joinCommandLines("", token, "img")).toEqual(joinCommands({ panelUrl: "", token, image: "img" }));
  });
});
