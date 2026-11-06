import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { InitError, parseInitArgs, runWorkerInit } from "./worker-init.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-worker-init-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

let dirs = 0;
const freshDir = () => path.join(sandbox, `out-${(dirs += 1)}`);

/** Minimal slice of the panel schema the CLI touches (users + workers). */
function panelDb({ withWorkers = true, withAdmin = true } = {}) {
  const file = path.join(sandbox, `panel-${(dirs += 1)}.db`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, created_at TEXT NOT NULL)");
  if (withWorkers) {
    db.exec(`CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER, last_seen_at INTEGER, version TEXT, capabilities TEXT NOT NULL DEFAULT '{}')`);
  }
  if (withAdmin) db.prepare("INSERT INTO users (id, role, created_at) VALUES ('admin-1', 'admin', '2026-01-01')").run();
  db.close();
  return file;
}

const env = (file) => ({ root: ROOT, version: "9.9.9", openDb: () => new DatabaseSync(file) });
const BASE = ["--name", "Máquina SP", "--panel-url", "https://painel.exemplo.com"];

describe("parseInitArgs", () => {
  it("parses every option with defaults", () => {
    expect(parseInitArgs(["--target", "compose", "--out", "kit", ...BASE])).toEqual({
      target: "compose", name: "Máquina SP", panelUrl: "https://painel.exemplo.com", replicas: 1, parallel: 1,
      executors: ["claude"], image: null, region: null, out: "kit", force: false,
    });
    const parsed = parseInitArgs(["--target", "k8s", "--out", "kit", ...BASE, "--replicas", "3", "--parallel", "2", "--executors", "claude,codex,claude", "--force"]);
    expect(parsed).toMatchObject({ replicas: 3, parallel: 2, executors: ["claude", "codex"], force: true });
  });

  it("agentcore needs neither name nor panel URL", () => {
    expect(parseInitArgs(["--target", "agentcore", "--out", "kit"])).toMatchObject({ target: "agentcore", name: "", panelUrl: null });
  });

  it.each([
    [["--out", "kit", ...BASE], "--target"],
    [["--target", "docker", "--out", "kit", ...BASE], "--target"],
    [["--target", "compose", ...BASE], "--out"],
    [["--target", "compose", "--out", "kit", "--panel-url", "https://x.dev"], "--name"],
    [["--target", "compose", "--out", "kit", "--name", "a"], "--panel-url"],
    [["--target", "compose", "--out", "kit", ...BASE, "--replicas", "0"], "--replicas"],
    [["--target", "compose", "--out", "kit", ...BASE, "--executors", "gpt"], "--executors"],
    [["--target", "compose", "--out", "kit", ...BASE, "--bogus", "1"], "desconhecida"],
    [["--target", "compose", "--out"], "precisa de um valor"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseInitArgs(argv)).toThrow(InitError);
    expect(() => parseInitArgs(argv)).toThrow(message);
  });
});

describe("runWorkerInit", () => {
  it("compose: creates the worker in the DB (hash only) and writes the kit with the token in .env (0600)", async () => {
    const file = panelDb();
    const out = freshDir();
    const result = await runWorkerInit(parseInitArgs(["--target", "compose", "--out", out, ...BASE, "--replicas", "2"]), env(file));

    expect(result.token).toMatch(/^cwk_[A-Za-z0-9_-]{43}$/);
    expect(result.files).toEqual(expect.arrayContaining([".env", "docker-compose.yml", "README.md"]));
    const dotenv = readFileSync(path.join(out, ".env"), "utf8");
    expect(dotenv).toContain(result.token);
    expect(statSync(path.join(out, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(out, "docker-compose.yml"), "utf8")).toContain("carbon-worker:9.9.9");

    const db = new DatabaseSync(file);
    const row = db.prepare("SELECT * FROM workers").get();
    db.close();
    expect(row).toMatchObject({ name: "Máquina SP", kind: "pool", created_by: "admin-1", revoked_at: null });
    expect(row.token_hash).toBe(createHash("sha256").update(result.token).digest("hex"));
  });

  it("k8s: writes kustomize files with the token only in secret.yaml", async () => {
    const out = freshDir();
    const result = await runWorkerInit(parseInitArgs(["--target", "k8s", "--out", out, ...BASE]), env(panelDb()));
    expect(result.files).toEqual(expect.arrayContaining(["kustomization.yaml", "secret.yaml", "deployment.yaml"]));
    const withToken = result.files.filter((f) => readFileSync(path.join(out, f), "utf8").includes(result.token));
    expect(withToken).toEqual(["secret.yaml"]);
  });

  it("agentcore: writes the kit without touching the database; deploy.sh is executable", async () => {
    const out = freshDir();
    const openDb = () => {
      throw new Error("não deveria abrir o banco");
    };
    const result = await runWorkerInit(parseInitArgs(["--target", "agentcore", "--out", out, "--panel-url", "https://painel.exemplo.com"]), { root: ROOT, version: "1.0.0", openDb });
    expect(result.token).toBeNull();
    expect(result.files).toEqual(expect.arrayContaining(["Dockerfile", "deploy.sh", "iam-policy.json", "README.md"]));
    expect(statSync(path.join(out, "deploy.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(out, "deploy.sh"), "utf8")).toContain("https://painel.exemplo.com");
  });

  it("refuses a non-empty folder without --force, and overwrites with it", async () => {
    const out = freshDir();
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "outro.txt"), "x");
    const file = panelDb();
    await expect(runWorkerInit(parseInitArgs(["--target", "compose", "--out", out, ...BASE]), env(file))).rejects.toThrow("não está vazia");
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workers").get().n).toBe(0);
    db.close();
    const result = await runWorkerInit(parseInitArgs(["--target", "compose", "--out", out, ...BASE, "--force"]), env(file));
    expect(result.token).toBeTruthy();
  });

  it("validates kit options before creating a worker", async () => {
    const file = panelDb();
    const argv = ["--target", "compose", "--out", freshDir(), ...BASE, "--image", "evil image;rm"];
    await expect(runWorkerInit(parseInitArgs(argv), env(file))).rejects.toThrow("image");
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT COUNT(*) AS n FROM workers").get().n).toBe(0);
    db.close();
  });

  it("explains an unmigrated database or a panel without admin", async () => {
    await expect(runWorkerInit(parseInitArgs(["--target", "compose", "--out", freshDir(), ...BASE]), env(panelDb({ withWorkers: false })))).rejects.toThrow("migrar");
    await expect(runWorkerInit(parseInitArgs(["--target", "compose", "--out", freshDir(), ...BASE]), env(panelDb({ withAdmin: false })))).rejects.toThrow("admin");
  });
});

describe("writeKitFiles (L8)", () => {
  it("writes through a temp file with the final mode and leaves no temp files; replaces a symlink instead of following it", async () => {
    const { writeKitFiles } = await import("./worker-init.mjs");
    const { lstatSync, readdirSync, symlinkSync } = await import("node:fs");
    const out = freshDir();
    const elsewhere = freshDir();
    mkdirSync(out, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const outside = path.join(elsewhere, "alvo");
    writeFileSync(outside, "original\n");
    symlinkSync(outside, path.join(out, ".env"));
    writeKitFiles(out, { ".env": "CARBON_WORKER_TOKEN=x\n", "deploy.sh": "#!/bin/sh\n", "README.md": "# kit\n" });
    expect(readFileSync(outside, "utf8")).toBe("original\n");
    expect(lstatSync(path.join(out, ".env")).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(out, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(out, "deploy.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(out, "README.md")).mode & 0o777).toBe(0o644);
    expect(readdirSync(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
