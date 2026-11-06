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

/** Panel data folder, same lookup as the server (CARBON_DATA_DIR, legacy .leonidas-data). */
function dataDirectory() {
  return path.resolve(ROOT, readEnv().CARBON_DATA_DIR ?? process.env.CARBON_DATA_DIR ?? (existsSync(path.join(ROOT, ".leonidas-data")) ? "./.leonidas-data" : "./.carbon-data"));
}

/** Prints where other computers connect and the exact `carbon join` command. */
async function printJoinHints(proxy) {
  const { formatFingerprint, lanAddresses } = await import("./worker-tls.mjs");
  const anyHost = proxy.host === "0.0.0.0" || proxy.host === "::";
  const hosts = anyHost ? lanAddresses() : [proxy.host];
  const fp = proxy.fingerprint;
  for (const host of hosts) p.log.info(`Workers: ${pc.cyan(`https://${host}:${proxy.port}`)} ${pc.dim("(só /api/worker/*; a UI segue em 127.0.0.1)")}`);
  p.log.info(`Certificado do listener (autoassinado${proxy.certCreated ? ", gerado agora" : ""}): ${pc.bold(formatFingerprint(fp))}`);
  const example = hosts[0] ?? "<ip-deste-computador>";
  p.note(
    [
      "Em Configurações → Máquinas → Adicionar máquina → Direto você gera o token.",
      "Na outra máquina (rede local):",
      `  ${pc.cyan(`carbon join ${example}:${proxy.port} --fingerprint ${fp}`)}`,
      "Pela internet: libere a porta " + proxy.port + " no roteador (port forwarding) e use",
      `  ${pc.cyan(`carbon join <ip-público>:${proxy.port} --fingerprint ${fp}`)}`,
    ].join("\n"),
    "Conectar outro computador",
  );
}

/** Starts the public worker listener when CARBON_WORKER_LISTEN is set (process env wins over .env.local). */
async function startWorkerListener(port) {
  const fileEnv = readEnv();
  const pick = (name) => process.env[name] ?? fileEnv[name];
  const listen = pick("CARBON_WORKER_LISTEN");
  if (!listen) return;
  const { startWorkerProxy } = await import("./worker-proxy.mjs");
  try {
    const proxy = await startWorkerProxy(
      {
        CARBON_WORKER_LISTEN: listen,
        CARBON_PORT: String(port),
        CARBON_WORKER_TLS: pick("CARBON_WORKER_TLS"),
        CARBON_WORKER_TLS_CERT: pick("CARBON_WORKER_TLS_CERT"),
        CARBON_WORKER_TLS_KEY: pick("CARBON_WORKER_TLS_KEY"),
        CARBON_WORKER_MAX_CONNECTIONS: pick("CARBON_WORKER_MAX_CONNECTIONS"),
        CARBON_WORKER_MAX_CONNECTIONS_PER_IP: pick("CARBON_WORKER_MAX_CONNECTIONS_PER_IP"),
      },
      { tlsDir: path.join(dataDirectory(), "worker-tls") },
    );
    // The panel (next start, spawned next) shows the same data in Configurações → Máquinas → Direto.
    process.env.CARBON_WORKER_JOIN_PORT = String(proxy.port);
    process.env.CARBON_WORKER_JOIN_HOST = proxy.host;
    process.env.CARBON_WORKER_JOIN_TLS = proxy.tlsMode;
    if (proxy.fingerprint) process.env.CARBON_WORKER_JOIN_FINGERPRINT = proxy.fingerprint;
    else delete process.env.CARBON_WORKER_JOIN_FINGERPRINT;
    if (proxy.tlsMode === "self-signed") {
      await printJoinHints(proxy);
    } else {
      p.log.info(`Workers remotos: ${pc.cyan(`${proxy.url}/api/worker/`)} ${pc.dim("(só /api/worker/*; a UI segue em 127.0.0.1)")}`);
      p.log.info(`Configure ${pc.cyan("panelPublicUrl")} nas configurações com a URL pública (túnel/VPN) que aponta para essa porta.`);
    }
    if (!proxy.tls) p.log.warn("Listener sem TLS: use só atrás de um túnel HTTPS (Cloudflare Tunnel, Tailscale) apontando para essa porta.");
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void proxy.close());
  } catch (err) {
    p.cancel(`Não consegui abrir o listener de workers: ${err.message}`);
    process.exit(1);
  }
}

async function start() {
  console.log(BANNER);
  await ensureBuilt(false);
  const port = Number(readEnv().CARBON_PORT ?? DEFAULT_PORT);
  await startWorkerListener(port);
  startServer(port, "/");
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
/** Panel database file, same lookup as the server (CARBON_DATA_DIR, legacy .leonidas-data). */
function databaseFile() {
  const dataDir = dataDirectory();
  return [path.join(dataDir, "carbon.db"), path.join(dataDir, "leonidas.db")].find((f) => existsSync(f)) ?? path.join(dataDir, "carbon.db");
}

async function resetPassword() {
  const { DatabaseSync } = await import("node:sqlite");
  const file = databaseFile();
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

const WORKER_BUNDLE = path.join(ROOT, "dist", "worker.mjs");

/**
 * `carbon worker [--version]`: runs the standalone worker (dist/worker.mjs), building it first if
 * missing. Configuration comes from CARBON_* environment variables (see src/worker/config.ts).
 */
async function worker() {
  const args = process.argv.slice(3);
  if (args[0] === "init") return workerInit(args.slice(1));
  process.exit(await runWorkerBundle(args, process.env));
}

/** Runs dist/worker.mjs (building it first if missing) with `env`; resolves with its exit code. */
async function runWorkerBundle(args, env) {
  if (!existsSync(WORKER_BUNDLE)) {
    console.error(pc.yellow("dist/worker.mjs não encontrado: gerando agora com `npm run build:worker` (precisa das devDependencies)…"));
    const built = spawnSync(process.execPath, [path.join(ROOT, "bin", "build-worker.mjs")], { cwd: ROOT, stdio: "inherit" });
    if (built.status !== 0 || !existsSync(WORKER_BUNDLE)) {
      console.error(pc.red("não consegui gerar dist/worker.mjs. Rode `npm install` e `npm run build:worker` e tente de novo."));
      return 1;
    }
  }
  const child = spawn(process.execPath, [WORKER_BUNDLE, ...args], { stdio: "inherit", env });
  // Ctrl+C from a terminal already reaches the child (same process group); forwarding it again
  // would count as a second signal and skip the graceful shutdown.
  const forwarded = process.stdin.isTTY ? ["SIGTERM", "SIGHUP"] : ["SIGTERM", "SIGHUP", "SIGINT"];
  for (const signal of forwarded) process.on(signal, () => child.kill(signal));
  if (process.stdin.isTTY) process.on("SIGINT", () => undefined);
  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(pc.red(`não consegui iniciar o worker: ${error.message}`));
      resolve(1);
    });
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
}

/**
 * `carbon join <ip>:<porta>`: this computer becomes a worker of the panel at that address
 * (LAN or public IP, no domain). Pins the listener's self-signed certificate, then runs the worker.
 */
async function join() {
  const { JOIN_USAGE, JoinError, parseJoinArgs, probeCertificate, resolvePin, workerEnv } = await import("./worker-join.mjs");
  const { formatFingerprint } = await import("./worker-tls.mjs");
  const argv = process.argv.slice(3);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(JOIN_USAGE);
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  try {
    const opts = parseJoinArgs(argv);
    p.intro(pc.inverse(" join "));
    const s = p.spinner();
    s.start(`Conectando em ${opts.target.host}:${opts.target.port}`);
    let probe;
    try {
      probe = await probeCertificate(opts.target.host, opts.target.port);
      s.stop("Certificado recebido");
    } catch (error) {
      s.stop("Sem conexão");
      throw error;
    }
    const confirm = interactive
      ? async (fp) => {
          p.note(`${pc.bold(formatFingerprint(fp))}\n\nCompare com o fingerprint mostrado no painel (Configurações → Máquinas → Direto,\nou no terminal do \`carbon start\`). Só aceite se forem iguais.`, "Primeiro contato com este painel");
          const answer = await p.confirm({ message: "O fingerprint confere?", initialValue: false });
          return !p.isCancel(answer) && answer === true;
        }
      : null;
    const pin = await resolvePin(opts, probe, confirm);
    p.log.info(pin ? `Certificado fixado: ${pc.dim(formatFingerprint(pin))}` : "Certificado válido por uma CA pública: sem fixar.");

    let token = opts.token ?? process.env.CARBON_WORKER_TOKEN?.trim() ?? null;
    if (!token) {
      if (!interactive) throw new JoinError("token ausente: defina CARBON_WORKER_TOKEN (gerado em Configurações → Máquinas)");
      const typed = await p.password({ message: "Token da máquina (cwk_…)", validate: (v) => (/^cwk_[A-Za-z0-9_-]{20,200}$/.test(String(v ?? "").trim()) ? undefined : "deve começar com cwk_") });
      if (p.isCancel(typed)) return p.cancel("Cancelado.");
      token = typed.trim();
    }
    p.outro(`${pc.green("●")} Worker ligado em ${pc.bold(opts.target.url)} ${pc.dim("(Ctrl+C para parar)")}`);
    process.exit(await runWorkerBundle([], workerEnv(process.env, opts, token, pin)));
  } catch (error) {
    if (!(error instanceof JoinError)) throw error;
    console.error(`${pc.red(error.message)}`);
    if (/endereço|opção|argumento|precisa/.test(error.message)) console.error(`\n${JOIN_USAGE}`);
    process.exit(1);
  }
}

/**
 * `carbon worker init`: writes the setup kit to --out. For compose/k8s the worker is created in
 * the panel database here (this runs on the panel host) and its token is printed once.
 */
async function workerInit(argv) {
  const { INIT_USAGE, InitError, parseInitArgs, runWorkerInit } = await import("./worker-init.mjs");
  let opts;
  try {
    opts = parseInitArgs(argv);
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    console.error(`${pc.red(error.message)}\n\n${INIT_USAGE}`);
    process.exit(1);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const openDb = () => {
    const file = databaseFile();
    if (!existsSync(file)) throw new InitError(`banco não encontrado em ${file}: rode o setup e inicie o painel primeiro`);
    return new DatabaseSync(file);
  };
  try {
    const result = await runWorkerInit(opts, { root: ROOT, version, openDb });
    console.log(`${pc.green("✔")} kit ${opts.target} em ${result.out}: ${result.files.join(", ")}`);
    if (result.token) {
      console.log(`\nMáquina "${result.worker.name}" criada. Token (mostrado só agora; já está no ${opts.target === "compose" ? ".env" : "secret.yaml"}):\n${pc.bold(result.token)}\n`);
      console.log(opts.target === "compose" ? `cd ${result.out} && docker compose up -d` : `kubectl apply -k ${result.out}`);
    } else {
      console.log(`Siga ${path.join(result.out, "README.md")} (experimental).`);
    }
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    console.error(pc.red(error.message));
    process.exit(1);
  }
}

const commands = { setup, doctor, start, "reset-password": resetPassword, worker, join };
const name = process.argv[2] ?? "setup";
if (!commands[name]) {
  console.log(`uso: carbon <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
commands[name]().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
