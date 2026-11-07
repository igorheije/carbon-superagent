import { version } from "../../package.json";
import { PROTOCOL_VERSION } from "../shared/worker-protocol";
import { readWorkerConfig, scrubSecretEnv, type WorkerConfig } from "./config";
import { EXIT_REMOVED, JoinError, leaveCluster, resolveCredential } from "./join";
import { JOIN_USAGE, parseJoinArgs } from "./join-args";
import { EXIT_FATAL, runWorkerLoop } from "./loop";
import { createPinnedFetch } from "./pinned-fetch";
import { markNodeRemoved, NodeStateError, readNodeState, removeNodeState } from "./node-state";

/**
 * Entry point of dist/worker.mjs. Configuration comes from the environment (see config.ts); `join`
 * also takes the panel URL and the cluster token as arguments, Docker Swarm style. Logs go to stderr
 * with a timestamp; tokens are never printed.
 *
 *   carbon worker                                  run (CARBON_WORKER_TOKEN, CARBON_JOIN_TOKEN or saved join)
 *   carbon join <url> --token cjt_… [--name n]     enter the cluster, then run
 *   carbon leave                                   leave the cluster and forget the saved credential
 */

const WORKER_VERSION = `${version}+p${PROTOCOL_VERSION}`;

const log = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} [carbon-worker] ${message}\n`);
};

function onSignals(config: WorkerConfig): AbortController {
  const controller = new AbortController();
  let signals = 0;
  const onSignal = (name: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) {
      log(`${name} de novo: saindo imediatamente`);
      process.exit(130);
    }
    log(`${name} recebido: parando de pegar tarefas (até ${config.graceSeconds}s para terminar as atuais)`);
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return controller;
}

/**
 * Certificate pin for this panel: CARBON_PANEL_FINGERPRINT (or `carbon join --fingerprint`), else the
 * one saved by an earlier join to the same panel, so a plain restart keeps pinning.
 */
function panelPin(config: WorkerConfig): string | undefined {
  if (config.panelFingerprint) return config.panelFingerprint;
  const saved = readNodeState(config.stateDir, config.hostname);
  return saved && saved.panelUrl === config.panelUrl ? (saved.panelFingerprint ?? undefined) : undefined;
}

async function run(config: WorkerConfig, explicitJoin: boolean): Promise<number> {
  const caps = { executors: config.executors, git: Boolean(config.gitToken), maxParallel: config.parallel, workerVersion: WORKER_VERSION };
  const pin = panelPin(config);
  const fetchImpl = pin ? createPinnedFetch(pin) : undefined;
  const credential = await resolveCredential({
    panelUrl: config.panelUrl,
    envToken: config.token || undefined,
    joinToken: config.joinToken,
    stateDir: config.stateDir,
    hostname: config.hostname,
    name: config.name,
    explicitJoin,
    caps,
    panelFingerprint: pin,
    fetchImpl,
    log,
  });
  const controller = onSignals(config);
  if (config.gitToken && config.gitHosts.length === 0) log("CARBON_GIT_TOKEN definido sem CARBON_GIT_HOSTS: o token não será enviado a nenhum remoto");
  const pinned = pin ? ` · certificado fixado ${pin.slice(0, 16)}…` : "";
  log(`carbon-worker ${WORKER_VERSION} · painel ${config.panelUrl}${pinned} · pasta ${config.workDir}${credential.nodeId ? ` · nó ${credential.nodeId.slice(0, 8)}` : ""}`);
  return runWorkerLoop({
    panelUrl: config.panelUrl,
    token: credential.token,
    executors: config.executors,
    parallel: config.parallel,
    workDir: config.workDir,
    gitToken: config.gitToken,
    gitHosts: config.gitHosts,
    graceSeconds: config.graceSeconds,
    fetchImpl,
    signal: controller.signal,
    workerVersion: WORKER_VERSION,
    log,
    onUnauthorized: () => {
      if (!credential.state) return undefined;
      markNodeRemoved(config.stateDir, config.hostname, credential.state);
      return { message: "este nó foi removido do cluster pelo admin; rode `carbon join <url> --token cjt_…` para entrar de novo", code: EXIT_REMOVED };
    },
  });
}

async function leave(env: Record<string, string | undefined>): Promise<number> {
  // leave only needs the state dir and hostname; the panel URL comes from the saved credential.
  const parsed = readWorkerConfig({ ...env, CARBON_PANEL_URL: "http://127.0.0.1", CARBON_WORKER_EXECUTORS: "claude" }, undefined, { allowJoin: true });
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`configuração inválida: ${error}`);
    return EXIT_FATAL;
  }
  const { stateDir, hostname } = parsed.config;
  const saved = readNodeState(stateDir, hostname);
  if (!saved) {
    log("este servidor não entrou em nenhum cluster (nenhuma credencial salva)");
    return 0;
  }
  const outcome = await leaveCluster(saved.panelUrl, saved.token, saved.panelFingerprint ? createPinnedFetch(saved.panelFingerprint) : undefined);
  removeNodeState(stateDir, hostname);
  log(outcome === "left" ? `saiu do cluster ${saved.panelUrl}` : "o painel já tinha removido este nó; credencial local apagada");
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`carbon-worker ${WORKER_VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  const env: Record<string, string | undefined> = { ...process.env };
  // Read once, then gone: nothing spawned later (git, the agent, its tools) inherits the tokens.
  scrubSecretEnv(process.env);

  if (command === "leave") return leave(env);
  if (command === "join") {
    const args = parseJoinArgs(rest, env.CARBON_JOIN_TOKEN);
    if ("error" in args) {
      log(`${args.error}\n${JOIN_USAGE}`);
      return EXIT_FATAL;
    }
    env.CARBON_PANEL_URL = args.panelUrl;
    env.CARBON_JOIN_TOKEN = args.token;
    delete env.CARBON_WORKER_TOKEN;
    if (args.name) env.CARBON_WORKER_NAME = args.name;
    if (args.fingerprint) env.CARBON_PANEL_FINGERPRINT = args.fingerprint;
  } else if (command !== undefined) {
    log(`comando desconhecido: ${command} (use join, leave ou nenhum)`);
    return EXIT_FATAL;
  }

  const parsed = readWorkerConfig(env, undefined, { allowJoin: true });
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`configuração inválida: ${error}`);
    return EXIT_FATAL;
  }
  return run(parsed.config, command === "join");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof JoinError) {
      log(error.message);
      process.exit(error.exitCode);
    }
    log(error instanceof NodeStateError ? error.message : `erro fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_FATAL);
  },
);
