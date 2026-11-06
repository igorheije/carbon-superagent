#!/usr/bin/env node
/**
 * E2E da execução distribuída — painel REAL + workers REAIS + "AgentCore" local, sem AWS.
 *
 * Uso (depois de `npm run build && npm run build:worker`):
 *
 *   npm run e2e:distributed            # ou: node scripts/e2e-distributed.mjs [--keep]
 *
 * O que faz, tudo num diretório temporário (CARBON_DATA_DIR próprio; nada do seu .carbon-data é tocado):
 *  1. Cria dois repositórios git: A com remoto bare (transporte git: clone/push) e B sem nenhum
 *     commit (transporte bundle pelo painel).
 *  2. Gera um certificado TLS autoassinado (openssl) — `panelPublicUrl` exige https.
 *  3. Sobe o painel com `next start` (127.0.0.1, porta livre) e o proxy de workers
 *     (bin/worker-proxy.mjs, o mesmo de CARBON_WORKER_LISTEN) com TLS em outra porta.
 *  4. Pelas MESMAS rotas da UI (cookie de sessão): /api/setup/complete (admin + projeto A),
 *     PUT /api/settings (panelPublicUrl, AgentCore), POST /api/projects (projeto B),
 *     POST /api/admin/workers (2 máquinas → 2 tokens) e POST /api/tasks (3 tarefas no pool).
 *  5. Sobe 2 processos `node dist/worker.mjs` apontados para o PROXY, com um `claude` falso no
 *     PATH (emite JSONL no formato do Claude Code e altera um arquivo), e espera as 3 tarefas
 *     chegarem a `done`.
 *  6. Confere: branch importado em cada repo, commit "feat: <título> (<KEY>)", placement gravado
 *     no snapshot, as duas máquinas trabalharam, e "Aplicar na pasta" (POST /api/tasks/:id/apply)
 *     funciona nos dois repos.
 *  7. AgentCore sem AWS: sobe `node dist/agentcore.mjs` (o entrypoint do container) e um endpoint
 *     falso da API do Bedrock AgentCore (AWS_ENDPOINT_URL aponta para ele, credenciais falsas).
 *     O dispatcher REAL do painel emite o token de tarefa e chama InvokeAgentRuntime; o endpoint
 *     falso repassa o payload para POST /invocations do container, que faz o claim pelo proxy e
 *     roda a tarefa. Confere `done`, branch importado, sessão no placement e StopRuntimeSession.
 *
 * Sai com código ≠ 0 em qualquer falha e imprime uma tabela-resumo. `--keep` mantém o diretório
 * temporário (logs do painel/workers em <tmp>/logs) para investigar.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const TIMEOUT_MS = { panel: 90_000, pool: 180_000, agentcore: 120_000, stop: 20_000 };
const FAKE_ARN = "arn:aws:bedrock-agentcore:sa-east-1:123456789012:runtime/carbon_e2e-AbC123";
const PASSWORD = "e2e-senha-forte-123";

// ---------------------------------------------------------------- summary / failure

const rows = [];
const started = Date.now();
let stepStart = Date.now();

function record(step, ok, detail = "") {
  rows.push({ step, ok, detail, ms: Date.now() - stepStart });
  stepStart = Date.now();
  process.stderr.write(`${ok ? "✔" : "✖"} ${step}${detail ? ` — ${detail}` : ""}\n`);
}

class E2EError extends Error {}
function check(condition, step, detail) {
  if (!condition) throw new E2EError(`${step}: ${detail}`);
}
/** Runs one step; `describe` turns its result into the summary detail. */
async function step(name, fn, describe = (value) => (typeof value === "string" ? value : "")) {
  try {
    const value = await fn();
    record(name, true, describe(value));
    return value;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function printSummary() {
  const width = Math.max(...rows.map((r) => r.step.length), 5);
  const line = (a, b, c, d) => `| ${a.padEnd(width)} | ${b.padEnd(6)} | ${c.padStart(7)} | ${d}`;
  const out = [
    "",
    line("Etapa", "Status", "Tempo", "Detalhe"),
    `|${"-".repeat(width + 2)}|--------|---------|${"-".repeat(40)}`,
    ...rows.map((r) => line(r.step, r.ok ? "ok" : "FALHOU", `${(r.ms / 1000).toFixed(1)}s`, r.detail)),
    "",
    `${rows.every((r) => r.ok) ? "PASSOU" : "FALHOU"} em ${((Date.now() - started) / 1000).toFixed(1)}s`,
  ];
  process.stdout.write(`${out.join("\n")}\n`);
}

// ---------------------------------------------------------------- processes & helpers

const children = [];
const servers = [];
let tmp = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startProcess(name, command, args, env) {
  const log = createWriteStream(path.join(tmp, "logs", `${name}.log`));
  const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push({ name, child });
  return child;
}

function tailLog(name, lines = 25) {
  const file = path.join(tmp, "logs", `${name}.log`);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

async function until(label, check, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new E2EError(`tempo esgotado esperando ${label}`);
    await sleep(everyMs);
  }
}

async function cleanup() {
  for (const { child } of children) if (child.exitCode === null) child.kill("SIGTERM");
  await sleep(1_500);
  for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
  for (const close of servers) await close().catch(() => undefined);
  if (tmp && !KEEP) rmSync(tmp, { recursive: true, force: true });
  else if (tmp) process.stderr.write(`diretório mantido: ${tmp}\n`);
}

/** Status code of an https request trusting `ca` (this process cannot use NODE_EXTRA_CA_CERTS). */
function httpsStatus(url, ca, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, ca, headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

// ---------------------------------------------------------------- fixtures

/** `claude` stand-in: answers --version and prints Claude Code stream-json that edits one file. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("2.0.0 (Claude Code)\\n");
  process.exit(0);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
// Wait for the prompt on stdin (stream-json), but never hang on it.
await new Promise((resolve) => {
  process.stdin.once("data", resolve);
  setTimeout(resolve, 2000).unref();
});
out({ type: "system", subtype: "init", session_id: "sess-e2e-" + process.pid, model: "fake-model" });
say("CARBON_PLAN: criar o arquivo do e2e");
await new Promise((resolve) => setTimeout(resolve, 1500));
const file = "e2e-" + process.pid + ".txt";
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: process.cwd() + "/" + file } }] } });
writeFileSync(file, "alterado pelo agente falso (pid " + process.pid + ")\\n");
say("CARBON_DONE: 1");
out({ type: "result", subtype: "success", is_error: false, result: "feito", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } });
process.exit(0);
`;

function makeFixtures() {
  tmp = mkdtempSync(path.join(tmpdir(), "carbon-e2e-dx-"));
  mkdirSync(path.join(tmp, "logs"));
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(path.join(bin, "claude"), 0o755);

  const repoA = path.join(tmp, "repo-com-remoto");
  mkdirSync(repoA);
  git(repoA, "init", "-q", "-b", "main");
  writeFileSync(path.join(repoA, "README.md"), "# repo A\n");
  git(repoA, "add", "-A");
  git(repoA, "commit", "-q", "-m", "init");
  git(tmp, "init", "-q", "--bare", "remoto-a.git");
  git(repoA, "remote", "add", "origin", path.join(tmp, "remoto-a.git"));
  git(repoA, "push", "-q", "-u", "origin", "main");
  git(repoA, "fetch", "-q", "origin");

  const repoB = path.join(tmp, "repo-sem-commits");
  mkdirSync(repoB);
  git(repoB, "init", "-q", "-b", "main");
  writeFileSync(path.join(repoB, "README.md"), "# repo B (sem commits)\n");

  // panelPublicUrl must be https: self-signed cert for 127.0.0.1, trusted by workers via NODE_EXTRA_CA_CERTS.
  const cert = path.join(tmp, "tls.crt");
  const key = path.join(tmp, "tls.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], {
    stdio: "ignore",
  });
  return { bin, repoA, repoB, cert, key, dataDir: path.join(tmp, "data") };
}

// ---------------------------------------------------------------- panel API (same routes as the UI)

function panelApi(baseUrl) {
  let cookie = "";
  return async function call(method, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) throw new E2EError(`${method} ${route} → ${response.status}: ${json?.error ?? "sem corpo"}`);
    return json.data;
  };
}

// ---------------------------------------------------------------- fake Bedrock AgentCore endpoint

/** Speaks just enough of the AgentCore data-plane API: Invoke → POST /invocations of the local container; Stop → 200. */
async function startFakeAgentCore(containerUrl) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = decodeURIComponent(req.url ?? "");
      try {
        if (url.includes("/invocations")) {
          calls.push({ kind: "invoke", sessionId: req.headers["x-amzn-bedrock-agentcore-runtime-session-id"] ?? null });
          const forwarded = await fetch(`${containerUrl}/invocations`, { method: "POST", headers: { "content-type": "application/json" }, body });
          const text = await forwarded.text();
          res.writeHead(200, { "content-type": "application/json", "x-amzn-bedrock-agentcore-runtime-session-id": String(req.headers["x-amzn-bedrock-agentcore-runtime-session-id"] ?? "") });
          res.end(text || "{}");
          return;
        }
        if (url.includes("/stopruntimesession")) {
          calls.push({ kind: "stop", sessionId: req.headers["x-amzn-bedrock-agentcore-runtime-session-id"] ?? null });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        calls.push({ kind: "unknown", url });
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"message":"rota desconhecida no AgentCore falso"}');
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: String(error) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

// ---------------------------------------------------------------- task reads (read-only DB)

async function openDb(dataDir) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "carbon.db"), { readOnly: true });
  return {
    ticket: (id) => {
      const row = db.prepare("SELECT snapshot FROM tasks WHERE id = ?").get(id);
      return row ? JSON.parse(row.snapshot) : null;
    },
    close: () => db.close(),
  };
}

function lastWarn(ticket) {
  return [...(ticket?.logs ?? [])].reverse().find((l) => l.level === "warn")?.text ?? "sem log de erro";
}

/** Waits until every ticket is done; fails fast when one fails. */
async function waitDone(db, ids, timeoutMs) {
  return until(
    `tarefas ${ids.length} em done`,
    () => {
      const tickets = ids.map((id) => db.ticket(id));
      const failed = tickets.find((t) => t?.status === "failed");
      if (failed) throw new E2EError(`${failed.key} falhou: ${lastWarn(failed)}`);
      return tickets.every((t) => t?.status === "done") ? tickets : null;
    },
    timeoutMs,
  );
}

function assertImported(repo, ticket) {
  const branch = ticket.workspace?.branch;
  check(branch, ticket.key, "sem workspace.branch");
  const subject = git(repo, "log", "-1", "--format=%s", branch);
  check(subject === `feat: ${ticket.title} (${ticket.key})`, ticket.key, `commit inesperado: "${subject}"`);
  check(ticket.diff?.length > 0, ticket.key, "diff vazio");
  return branch;
}

// ---------------------------------------------------------------- main

async function main() {
  for (const file of [".next/BUILD_ID", "dist/worker.mjs", "dist/agentcore.mjs"]) {
    if (!existsSync(path.join(ROOT, file))) throw new E2EError(`falta ${file}: rode antes "npm run build && npm run build:worker"`);
  }
  const fx = await step("fixtures (repos, claude falso, TLS)", async () => makeFixtures(), () => `repo A com remoto bare · repo B sem commits · ${tmp}`);

  const [panelPort, proxyPort, containerPort, directPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  // "Direto" (carbon join <ip>:<porta>): listener with the panel's own self-signed certificate, pinned by fingerprint.
  const { ensureWorkerCert } = await import(path.join(ROOT, "bin/worker-tls.mjs"));
  const directTlsDir = path.join(fx.dataDir, "worker-tls");
  const directPin = ensureWorkerCert(directTlsDir).fingerprint;
  const directUrl = `https://127.0.0.1:${directPort}`;
  const panelUrl = `http://127.0.0.1:${panelPort}`;
  const publicUrl = `https://127.0.0.1:${proxyPort}`;
  const containerUrl = `http://127.0.0.1:${containerPort}`;
  const fakeAws = await startFakeAgentCore(containerUrl);
  const PATH = `${fx.bin}${path.delimiter}${process.env.PATH}`;

  await step("painel (next start) + proxy TLS", async () => {
    startProcess("panel", process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(panelPort)], {
      ...process.env,
      PATH,
      NODE_ENV: "production",
      CARBON_DATA_DIR: fx.dataDir,
      AWS_ACCESS_KEY_ID: "AKIAE2EFAKEFAKEFAKE0",
      AWS_SECRET_ACCESS_KEY: "fake-secret-e2e",
      AWS_REGION: "sa-east-1",
      AWS_ENDPOINT_URL: fakeAws.url,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: fakeAws.url,
      // what `carbon start` exports after opening the listener
      CARBON_WORKER_JOIN_PORT: String(directPort),
      CARBON_WORKER_JOIN_HOST: "127.0.0.1",
      CARBON_WORKER_JOIN_TLS: "self-signed",
      CARBON_WORKER_JOIN_FINGERPRINT: directPin,
    });
    await until("painel responder", async () => (await fetch(`${panelUrl}/api/setup/status`).catch(() => null))?.ok, TIMEOUT_MS.panel).catch((error) => {
      throw new E2EError(`${error.message}\n${tailLog("panel")}`);
    });
    const { startWorkerProxy } = await import(path.join(ROOT, "bin/worker-proxy.mjs"));
    const proxyLog = createWriteStream(path.join(tmp, "logs", "proxy.log"));
    const proxy = await startWorkerProxy({ CARBON_WORKER_LISTEN: `127.0.0.1:${proxyPort}`, CARBON_PORT: String(panelPort), CARBON_WORKER_TLS_CERT: fx.cert, CARBON_WORKER_TLS_KEY: fx.key }, {
      log: (line) => proxyLog.write(`${line}\n`),
    });
    servers.push(proxy.close);
    const ca = readFileSync(fx.cert);
    const [ui, hello] = [await httpsStatus(`${publicUrl}/api/tasks`, ca), await httpsStatus(`${publicUrl}/api/worker/hello`, ca, "POST")];
    check(proxy.tls && ui === 404 && hello === 401, "proxy", `esperava UI 404 e /api/worker/hello 401 sem token (veio ${ui} / ${hello})`);
    const direct = await startWorkerProxy({ CARBON_WORKER_LISTEN: `127.0.0.1:${directPort}`, CARBON_PORT: String(panelPort), CARBON_WORKER_TLS: "on" }, {
      tlsDir: directTlsDir,
      log: (line) => proxyLog.write(`[direto] ${line}\n`),
    });
    servers.push(direct.close);
    check(direct.tlsMode === "self-signed" && direct.fingerprint === directPin, "listener direto", "certificado autoassinado não reaproveitado");
    return `UI ${panelUrl} · workers ${publicUrl} · direto ${directUrl}`;
  });

  const api = panelApi(panelUrl);
  const ids = await step("admin, projetos, máquinas e 3 tarefas pool (rotas da UI)", async () => {
    await api("POST", "/api/setup/complete", { name: "Admin E2E", email: "admin@e2e.local", password: PASSWORD, persona: "engineering", executor: "claude", repoPath: fx.repoA, aiSummary: false });
    await api("PUT", "/api/settings", {
      panelPublicUrl: publicUrl,
      agentcore: { enabled: true, region: "sa-east-1", runtimeArn: FAKE_ARN, qualifier: "DEFAULT", maxConcurrent: 1 },
    });
    const { projects } = await api("GET", "/api/projects");
    const projectA = projects.find((p) => p.repoPath === fx.repoA);
    const { project: projectB } = await api("POST", "/api/projects", { repoPath: fx.repoB, name: "repo-sem-commits" });
    const machines = [];
    machines.push(await api("POST", "/api/admin/workers", { name: "e2e-maquina-1", target: "compose", executors: ["claude"] }));
    const joined = await api("POST", "/api/admin/workers", { name: "e2e-maquina-2", target: "direct", executors: ["claude"] });
    check(joined.direct?.fingerprint === directPin && joined.direct.port === directPort, "direto", `painel devolveu ${JSON.stringify(joined.direct)}`);
    machines.push(joined);
    await api("POST", "/api/projects/active", { id: projectA.id });
    const a1 = (await api("POST", "/api/tasks", { title: "Ajustar rodapé", description: "e2e git 1", runtime: "pool" })).task;
    const a2 = (await api("POST", "/api/tasks", { title: "Corrigir cabeçalho", description: "e2e git 2", runtime: "pool" })).task;
    await api("POST", "/api/projects/active", { id: projectB.id });
    const b1 = (await api("POST", "/api/tasks", { title: "Primeiro arquivo", description: "e2e bundle", runtime: "pool" })).task;
    return { a: [a1.id, a2.id], b: b1.id, projectA: projectA.id, tokens: machines.map((m) => ({ name: m.worker.name, token: m.token })) };
  }, (v) => `${v.tokens.length} máquinas · 3 tarefas (2 git, 1 bundle)`);

  const db = await openDb(fx.dataDir);
  try {
    const workerEnv = (machine, n) => ({
      ...process.env,
      PATH,
      NODE_EXTRA_CA_CERTS: fx.cert,
      CARBON_PANEL_URL: publicUrl,
      CARBON_WORKER_TOKEN: machine.token,
      CARBON_WORKER_EXECUTORS: "claude",
      CARBON_WORKER_PARALLEL: "1",
      CARBON_WORKER_DIR: path.join(tmp, `worker-${n}`),
      CARBON_WORKER_GRACE_SECONDS: "5",
    });
    const tickets = await step("worker por kit + worker por `carbon join` (IP:porta, fingerprint) → 3 tarefas done", async () => {
      const [kit, joined] = ids.tokens;
      startProcess("worker-1", process.execPath, [path.join(ROOT, "dist/worker.mjs")], workerEnv(kit, 1));
      // No NODE_EXTRA_CA_CERTS: trust comes only from the pinned fingerprint.
      const { NODE_EXTRA_CA_CERTS: _ca, CARBON_PANEL_URL: _url, ...joinEnv } = workerEnv(joined, 2);
      startProcess("worker-2", process.execPath, [path.join(ROOT, "bin/carbon.mjs"), "join", `127.0.0.1:${directPort}`, "--fingerprint", directPin, "--executors", "claude"], joinEnv);
      const done = await waitDone(db, [...ids.a, ids.b], TIMEOUT_MS.pool).catch((error) => {
        throw new E2EError(`${error.message}\n--- worker-1\n${tailLog("worker-1")}\n--- worker-2\n${tailLog("worker-2")}`);
      });
      return done;
    }, (done) => done.map((t) => `${t.key}@${t.placement?.workerName ?? "?"}`).join(" · "));

    await step("branches importados + commit 'feat: <título> (<KEY>)'", async () => {
      const [a1, a2, b1] = tickets;
      const branches = [assertImported(fx.repoA, a1), assertImported(fx.repoA, a2), assertImported(fx.repoB, b1)];
      check(a1.workspace.base === "main" && b1.workspace.base === "(sem commits)", "base", `bases inesperadas: ${a1.workspace.base} / ${b1.workspace.base}`);
      check(git(path.join(tmp, "remoto-a.git"), "branch", "--list", a1.workspace.branch) !== "", "push", "branch de A não chegou ao remoto (transporte git)");
      return branches.join(", ");
    });

    await step("placement no snapshot + as 2 máquinas trabalharam", async () => {
      const names = new Set(tickets.map((t) => t.placement?.workerName));
      for (const t of tickets) check(t.placement?.runtime === "pool" && t.placement.workerName, t.key, "placement ausente");
      check(names.size === 2, "placement", `só ${[...names].join(", ")} pegou tarefas`);
      return [...names].join(" + ");
    });

    await step("Aplicar na pasta (repo A e repo B)", async () => {
      await api("POST", `/api/tasks/${ids.a[0]}/apply`);
      await api("POST", `/api/tasks/${ids.b}/apply`);
      const changedA = git(fx.repoA, "status", "--porcelain");
      const changedB = git(fx.repoB, "status", "--porcelain");
      check(/e2e-\d+\.txt/.test(changedA), "apply A", `nada aplicado em A: ${changedA}`);
      check(/e2e-\d+\.txt/.test(changedB), "apply B", `nada aplicado em B: ${changedB}`);
      return "arquivos do agente na pasta dos dois projetos";
    });

    await step("AgentCore local (dist/agentcore.mjs) via dispatcher do painel", async () => {
      startProcess("agentcore", process.execPath, [path.join(ROOT, "dist/agentcore.mjs")], {
        ...process.env,
        PATH,
        PORT: String(containerPort),
        NODE_EXTRA_CA_CERTS: fx.cert,
        CARBON_PANEL_URL: publicUrl,
        CARBON_WORKER_DIR: path.join(tmp, "agentcore"),
        CARBON_WORKER_GRACE_SECONDS: "5",
      });
      await until("container /ping", async () => (await fetch(`${containerUrl}/ping`).catch(() => null))?.ok, 15_000);
      await api("POST", "/api/projects/active", { id: ids.projectA });
      const task = (await api("POST", "/api/tasks", { title: "Rodar no AgentCore", description: "e2e agentcore", runtime: "agentcore" })).task;
      const [done] = await waitDone(db, [task.id], TIMEOUT_MS.agentcore).catch((error) => {
        throw new E2EError(`${error.message}\naws falso: ${JSON.stringify(fakeAws.calls)}\n--- agentcore\n${tailLog("agentcore")}\n--- panel\n${tailLog("panel")}`);
      });
      assertImported(fx.repoA, done);
      check(done.placement?.runtime === "agentcore" && done.placement.agentcoreSessionId?.startsWith("carbon-task-"), done.key, "placement AgentCore ausente");
      check(fakeAws.calls.some((c) => c.kind === "invoke"), "invoke", "InvokeAgentRuntime não chegou ao endpoint falso");
      return done;
    }, (done) => `${done.key} done · sessão ${done.placement.agentcoreSessionId}`);

    await step("StopRuntimeSession ao terminar", async () => {
      await until("Stop da sessão", () => fakeAws.calls.some((c) => c.kind === "stop"), TIMEOUT_MS.stop);
      const unknown = fakeAws.calls.filter((c) => c.kind === "unknown");
      check(unknown.length === 0, "aws falso", `chamadas inesperadas: ${JSON.stringify(unknown)}`);
      return `${fakeAws.calls.map((c) => c.kind).join(" → ")}`;
    });
  } finally {
    db.close();
  }
}

process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(130));
});

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  if (!(error instanceof E2EError) && !rows.some((r) => !r.ok)) record("erro inesperado", false, error instanceof Error ? error.stack ?? error.message : String(error));
  else if (error instanceof E2EError && error.message.includes("\n")) process.stderr.write(`\n${error.message}\n`);
} finally {
  await cleanup();
  printSummary();
}
process.exit(exitCode);
