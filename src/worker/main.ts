import { version } from "../../package.json";
import { PROTOCOL_VERSION } from "../shared/worker-protocol";
import { readWorkerConfig, scrubSecretEnv } from "./config";
import { EXIT_FATAL, runWorkerLoop } from "./loop";
import { createPinnedFetch } from "./pinned-fetch";

/**
 * Entry point of dist/worker.mjs (`carbon worker`). Configuration comes from the environment
 * (see config.ts). Logs go to stderr with a timestamp; the worker token is never printed.
 */

const WORKER_VERSION = `${version}+p${PROTOCOL_VERSION}`;

const log = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} [carbon-worker] ${message}\n`);
};

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`carbon-worker ${WORKER_VERSION}\n`);
    return 0;
  }
  const parsed = readWorkerConfig(process.env);
  // Read once, then gone: nothing spawned later (git, the agent, its tools) inherits the tokens.
  scrubSecretEnv(process.env);
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`configuração inválida: ${error}`);
    return EXIT_FATAL;
  }
  const { config } = parsed;
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

  if (config.gitToken && config.gitHosts.length === 0) log("CARBON_GIT_TOKEN definido sem CARBON_GIT_HOSTS: o token não será enviado a nenhum remoto");
  const pinned = config.panelFingerprint ? ` · certificado fixado ${config.panelFingerprint.slice(0, 16)}…` : "";
  log(`carbon-worker ${WORKER_VERSION} · painel ${config.panelUrl}${pinned} · pasta ${config.workDir}`);
  return runWorkerLoop({
    panelUrl: config.panelUrl,
    token: config.token,
    executors: config.executors,
    parallel: config.parallel,
    workDir: config.workDir,
    gitToken: config.gitToken,
    gitHosts: config.gitHosts,
    graceSeconds: config.graceSeconds,
    fetchImpl: config.panelFingerprint ? createPinnedFetch(config.panelFingerprint) : undefined,
    signal: controller.signal,
    workerVersion: WORKER_VERSION,
    log,
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(`erro fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_FATAL);
  },
);
