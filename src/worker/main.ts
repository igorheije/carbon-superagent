import { version } from "../../package.json";
import { PROTOCOL_VERSION } from "../shared/worker-protocol";
import { readWorkerConfig } from "./config";
import { EXIT_FATAL, runWorkerLoop } from "./loop";

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

  log(`carbon-worker ${WORKER_VERSION} · painel ${config.panelUrl} · pasta ${config.workDir}`);
  return runWorkerLoop({
    panelUrl: config.panelUrl,
    token: config.token,
    executors: config.executors,
    parallel: config.parallel,
    workDir: config.workDir,
    gitToken: config.gitToken,
    graceSeconds: config.graceSeconds,
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
