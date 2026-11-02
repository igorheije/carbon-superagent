#!/usr/bin/env node
// Carbon CLI — interactive setup, doctor and launcher. Zero config beyond Node 22.13+.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scrypt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env.local");
const DEFAULT_PORT = 3417;
const HOST = "127.0.0.1";
const MIN_NODE = [22, 13];

const BANNER = `
  ${pc.bold(" ██████  █████  ██████  ██████   ██████  ███    ██")}
  ${pc.bold("██      ██   ██ ██   ██ ██   ██ ██    ██ ████   ██")}
  ${pc.bold("██      ███████ ██████  ██████  ██    ██ ██ ██  ██")}
  ${pc.bold("██      ██   ██ ██   ██ ██   ██ ██    ██ ██  ██ ██")}
  ${pc.bold(" ██████ ██   ██ ██   ██ ██████   ██████  ██   ████")} ${pc.green("SuperAgent")}
  ${pc.dim("agentes autônomos · Claude Code + Codex · no seu computador")}
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout ?? 20_000, cwd: opts.cwd ?? ROOT, shell: process.platform === "win32" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const first = (text) => text.split(/\r?\n/)[0] ?? "";

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

function writeEnv(values) {
  const merged = { ...readEnv(), ...values };
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(ENV_FILE, `# Carbon local config (gerado por npm run setup)\n${body}\n`, { mode: 0o600 });
}

function checkNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { id: "node", label: "Node.js", status: ok ? "ok" : "missing", detail: `v${process.versions.node}`, fix: "nvm install 22 && nvm use 22" };
}

function checkBin(id, label, args, fix) {
  const r = sh(id, args);
  return { id, label, status: r.ok ? "ok" : "missing", detail: r.ok ? first(r.out) : "não encontrado", fix };
}

function runChecks() {
  const checks = [
    checkNode(),
    checkBin("git", "Git", ["--version"], "https://git-scm.com/downloads"),
    checkBin("gh", "GitHub CLI (opcional)", ["--version"], "brew install gh  # ou https://cli.github.com"),
    checkBin("claude", "Claude Code", ["--version"], "npm i -g @anthropic-ai/claude-code"),
    checkBin("codex", "Codex CLI", ["--version"], "npm i -g @openai/codex"),
  ];
  const claude = checks.find((c) => c.id === "claude");
  const gh = checks.find((c) => c.id === "gh");
  if (gh.status === "ok") {
    const auth = sh("gh", ["auth", "status"]);
    if (!auth.ok) Object.assign(gh, { status: "warn", detail: `${gh.detail} · sem login`, fix: "gh auth login" });
  } else Object.assign(gh, { status: "optional", detail: "opcional · sem gh só commit local" });
  const codex = checks.find((c) => c.id === "codex");
  if (codex.status === "ok") {
    const auth = sh("codex", ["login", "status"]);
    if (!/logged in/i.test(auth.out)) Object.assign(codex, { status: "warn", detail: `${codex.detail} · login não confirmado`, fix: "codex login" });
  }
  // Only one agent is required: the missing one is optional when the other is present.
  const hasClaude = claude.status !== "missing";
  const hasCodex = codex.status !== "missing";
  if (hasClaude && !hasCodex) Object.assign(codex, { status: "optional", detail: "não instalado · opcional (Claude Code já atende)" });
  if (hasCodex && !hasClaude) Object.assign(claude, { status: "optional", detail: "não instalado · opcional (Codex já atende)" });
  return checks;
}

const ICON = { ok: pc.green("✔"), warn: pc.yellow("▲"), missing: pc.red("✖"), optional: pc.dim("–") };

function printChecks(checks) {
  const lines = checks.map((c) => {
    const fix = (c.status === "missing" || c.status === "warn") && c.fix ? `\n     ${pc.dim("→")} ${pc.cyan(c.fix)}` : "";
    return `${ICON[c.status]} ${c.label.padEnd(22)} ${pc.dim(c.detail)}${fix}`;
  });
  p.note(lines.join("\n"), "Ambiente");
}

const hasExecutor = (checks) => checks.some((c) => (c.id === "claude" || c.id === "codex") && (c.status === "ok" || c.status === "warn"));

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless machine: the URL is printed anyway
  }
}

function runStep(label, cmd, args) {
  return new Promise((resolve) => {
    const s = p.spinner();
    s.start(label);
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let tail = "";
    const keep = (chunk) => (tail = (tail + chunk.toString()).slice(-3000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("close", (code) => {
      if (code === 0) s.stop(`${label} ${pc.green("ok")}`);
      else {
        s.stop(`${label} ${pc.red("falhou")}`);
        p.log.error(tail);
      }
      resolve(code === 0);
    });
  });
}

async function installExecutor(checks) {
  if (hasExecutor(checks)) return checks;
  p.log.warn("Nenhum agente encontrado. O Carbon precisa de UM deles: Claude Code ou Codex.");
  const choice = await p.select({
    message: "Instalar qual agora?",
    options: [
      { value: "claude", label: "Claude Code", hint: "usa seu plano Claude Pro/Max" },
      { value: "codex", label: "Codex", hint: "usa seu login do ChatGPT" },
      { value: "skip", label: "Vou instalar depois" },
    ],
  });
  if (p.isCancel(choice) || choice === "skip") return checks;
  const pkg = choice === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
  await runStep(`npm i -g ${pkg}`, "npm", ["i", "-g", pkg]);
  if (choice === "codex") {
    const login = await p.confirm({ message: "Fazer login no Codex agora? (abre o navegador)" });
    if (login === true) spawnSync("codex", ["login"], { stdio: "inherit" });
  } else {
    p.note(`Rode ${pc.cyan("claude")} uma vez no terminal e faça login com ${pc.cyan("/login")}.\nDepois volte aqui.`, "Login do Claude Code");
  }
  return runChecks();
}

async function ensureBuilt(force) {
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    if (!(await runStep("Instalando dependências", "npm", ["install", "--no-fund", "--no-audit"]))) process.exit(1);
  }
  if (force || !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    if (!(await runStep("Compilando o painel", "npx", ["next", "build", "--turbopack"]))) process.exit(1);
  }
}

function startServer(port, openPath) {
  const url = `http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${port}${openPath}`;
  p.outro(`${pc.green("●")} Carbon no ar em ${pc.bold(pc.underline(url))}  ${pc.dim("(Ctrl+C para parar)")}`);
  const child = spawn("npx", ["next", "start", "-H", HOST, "-p", String(port)], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() },
  });
  setTimeout(() => openBrowser(url), 1500);
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("close", (code) => process.exit(code ?? 0));
}

async function setup() {
  console.log(BANNER);
  p.intro(pc.inverse(" setup "));
  const s = p.spinner();
  s.start("Olhando seu computador");
  let checks = runChecks();
  s.stop("Ambiente verificado");
  printChecks(checks);
  if (checks[0].status !== "ok") {
    p.cancel("Node 22.13+ é obrigatório (node:sqlite embutido).");
    process.exit(1);
  }
  checks = await installExecutor(checks);

  const env = readEnv();
  const port = await p.text({
    message: "Porta do painel",
    initialValue: env.CARBON_PORT ?? String(DEFAULT_PORT),
    validate: (v) => (/^\d{2,5}$/.test(v) && Number(v) < 65536 ? undefined : "porta inválida"),
  });
  if (p.isCancel(port)) return p.cancel("Setup cancelado.");
  writeEnv({ CARBON_PORT: port, CARBON_DATA_DIR: env.CARBON_DATA_DIR ?? "./.carbon-data" });
  p.log.info(`Dados locais em ${pc.cyan(".carbon-data/")} · painel só em ${pc.cyan(HOST)} (não exposto na rede)`);

  await ensureBuilt(true);
  if (!hasExecutor(checks)) p.log.warn("Sem agente instalado: o painel abre em modo demo até você instalar um.");
  p.note("O navegador vai abrir o assistente: perfil, agente e repositório.", "Próximo passo");
  startServer(Number(port), "/setup");
}

async function doctor() {
  console.log(BANNER);
  const checks = runChecks();
  printChecks(checks);
  if (!hasExecutor(checks)) {
    p.outro(pc.yellow("Instale Claude Code ou Codex para rodar tarefas reais."));
    process.exit(1);
  }
  p.outro(pc.green("Pronto para rodar."));
}

async function start() {
  console.log(BANNER);
  await ensureBuilt(false);
  startServer(Number(readEnv().CARBON_PORT ?? DEFAULT_PORT), "/");
}

/** Same format as src/server/auth/password.ts: scrypt$<salt b64>$<hash b64>. */
function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString("base64")}$${key.toString("base64")}`)));
  });
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

/**
 * Local recovery: whoever can run this on the machine already owns the database file,
 * so no e-mail round-trip is needed. Sessions of the account are revoked.
 */
async function resetPassword() {
  const { DatabaseSync } = await import("node:sqlite");
  const dataDir = path.resolve(ROOT, readEnv().CARBON_DATA_DIR ?? process.env.CARBON_DATA_DIR ?? (existsSync(path.join(ROOT, ".leonidas-data")) ? "./.leonidas-data" : "./.carbon-data"));
  const file = [path.join(dataDir, "carbon.db"), path.join(dataDir, "leonidas.db")].find((f) => existsSync(f)) ?? path.join(dataDir, "carbon.db");
  if (!existsSync(file)) {
    p.cancel(`Banco não encontrado em ${file}. Rode o setup primeiro.`);
    process.exit(1);
  }
  const db = new DatabaseSync(file);
  const users = db.prepare("SELECT id, email, name, role FROM users ORDER BY created_at").all();
  if (users.length === 0) {
    p.cancel("Nenhuma conta ainda. Abra /setup para criar o admin.");
    process.exit(1);
  }
  p.intro(pc.inverse(" redefinir senha "));
  let email = typeof flag("email") === "string" ? String(flag("email")).toLowerCase() : null;
  if (!email) {
    const picked = await p.select({ message: "Qual conta?", options: users.map((u) => ({ value: u.email, label: `${u.name} <${u.email}>`, hint: u.role })) });
    if (p.isCancel(picked)) return p.cancel("Cancelado.");
    email = picked;
  }
  const user = users.find((u) => u.email === email);
  if (!user) {
    p.cancel(`Conta ${email} não existe.`);
    process.exit(1);
  }
  let password;
  let isTemporary = true;
  if (flag("generate")) {
    password = randomBytes(12).toString("base64url");
  } else {
    const typed = await p.password({ message: "Nova senha (vazio = gerar uma temporária)", validate: (v) => (v && v.length < 10 ? "mín. 10 caracteres" : undefined) });
    if (p.isCancel(typed)) return p.cancel("Cancelado.");
    if (typed) {
      password = typed;
      isTemporary = false;
    } else {
      password = randomBytes(12).toString("base64url");
    }
  }
  const hash = await hashPassword(password);
  db.exec("BEGIN");
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?").run(hash, isTemporary ? 1 : 0, user.id);
  const revoked = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id).changes;
  db.exec("COMMIT");
  db.close();
  if (isTemporary) p.note(`${pc.bold(password)}\n\nTroque em Configurações → Perfil depois de entrar.`, `Senha temporária de ${user.email}`);
  p.outro(`${pc.green("✔")} Senha redefinida · ${revoked} sessão(ões) encerrada(s).`);
}

const commands = { setup, doctor, start, "reset-password": resetPassword };
const name = process.argv[2] ?? "setup";
if (!commands[name]) {
  console.log(`uso: carbon <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
commands[name]().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
