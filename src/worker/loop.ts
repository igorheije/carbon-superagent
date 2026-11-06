import type { ExecutorId } from "../shared/executors";
import type { ClaimedTask } from "../shared/worker-protocol";
import { backoffMs, createWorkerClient, ProtocolTooOld, WorkerClientError, type SleepFn, type WorkerClient } from "./client";
import { runClaimedTask, type RunOutcome, type RunTaskDeps } from "./run-task";

/**
 * `carbon worker` main loop (WRK-06): hello, then N slots that each long-poll a claim and run the
 * task. On shutdown (signal aborted): stop claiming, wait up to `graceSeconds` for running tasks,
 * then cancel them (each reports "canceled") and resolve with exit code 0.
 *
 * Exit codes: 0 graceful stop · 1 fatal (token refused, bad config) · 2 protocol too old (426).
 */

export const EXIT_OK = 0;
export const EXIT_FATAL = 1;
export const EXIT_PROTOCOL = 2;

export interface WorkerLoopOptions {
  readonly panelUrl: string;
  readonly token: string;
  readonly executors: readonly ExecutorId[];
  readonly parallel: number;
  readonly workDir: string;
  readonly gitToken?: string;
  readonly gitHosts?: readonly string[];
  readonly graceSeconds: number;
  readonly signal: AbortSignal;
  readonly workerVersion?: string;
  readonly log?: (message: string) => void;
  /** Test hooks. */
  readonly client?: WorkerClient;
  readonly runTask?: (task: ClaimedTask, deps: RunTaskDeps) => Promise<RunOutcome>;
  readonly sleep?: SleepFn;
}

class FatalStop extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const abortableSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Errors that end the worker instead of being retried. */
function fatalFrom(error: unknown): FatalStop | null {
  if (error instanceof ProtocolTooOld) return new FatalStop(`o painel exige um worker mais novo: ${error.message}`, EXIT_PROTOCOL);
  if (error instanceof WorkerClientError && !error.retryable) {
    const auth = error.status === 401 || error.status === 403;
    return new FatalStop(auth ? "o painel recusou o token do worker (revogado ou inválido)" : error.message, EXIT_FATAL);
  }
  if (!(error instanceof WorkerClientError)) return new FatalStop(describe(error), EXIT_FATAL);
  return null;
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<number> {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? abortableSleep;
  const runTask = options.runTask ?? runClaimedTask;
  const client = options.client ?? createWorkerClient({ panelUrl: options.panelUrl, token: options.token });
  const { signal } = options;
  /** Aborted when the grace period is over: running tasks stop and report canceled. */
  const cancelTasks = new AbortController();
  /** Aborted on shutdown or fatal error: no new claims, pending long-polls end. */
  const stopClaims = new AbortController();
  const running = new Set<Promise<RunOutcome>>();
  let fatal: FatalStop | null = null;

  const stop = (reason: FatalStop | null) => {
    if (reason && !fatal) fatal = reason;
    stopClaims.abort();
  };
  const onSignal = () => stop(null);
  if (signal.aborted) onSignal();
  signal.addEventListener("abort", onSignal, { once: true });

  // -------------------------------------------------------------- hello (retried on network errors)

  for (let attempt = 0; !stopClaims.signal.aborted; attempt++) {
    try {
      const hello = await client.hello({ executors: [...options.executors], git: Boolean(options.gitToken), maxParallel: options.parallel, workerVersion: options.workerVersion });
      log(`conectado ao painel (protocolo ${hello.protocol}, lease ${Math.round(hello.leaseMs / 1000)}s) · ${options.parallel} slot(s) · ${options.executors.join(", ")}`);
      break;
    } catch (error) {
      const fatalStop = fatalFrom(error);
      if (fatalStop) {
        stop(fatalStop);
        break;
      }
      log(`painel indisponível (${describe(error)}); tentando de novo`);
      await sleep(backoffMs(attempt, Math.random), stopClaims.signal);
    }
  }

  // -------------------------------------------------------------- slots

  async function slot(index: number): Promise<void> {
    let attempt = 0;
    while (!stopClaims.signal.aborted) {
      let task: ClaimedTask | null;
      try {
        task = await client.claim([...options.executors], stopClaims.signal);
        attempt = 0;
      } catch (error) {
        const fatalStop = fatalFrom(error);
        if (fatalStop) return stop(fatalStop);
        log(`slot ${index}: claim falhou (${describe(error)}); tentando de novo`);
        await sleep(backoffMs(attempt++, Math.random), stopClaims.signal);
        continue;
      }
      if (!task) continue;
      log(`slot ${index}: tarefa ${task.key} recebida`);
      const run = runTask(task, { client, workDir: options.workDir, gitToken: options.gitToken, gitHosts: options.gitHosts, signal: cancelTasks.signal, log }).catch((error: unknown): RunOutcome => {
        log(`slot ${index}: erro inesperado em ${task.key}: ${describe(error)}`);
        return "failed";
      });
      running.add(run);
      const outcome = await run;
      running.delete(run);
      log(`slot ${index}: tarefa ${task.key} terminou: ${outcome}`);
    }
  }

  const slots = stopClaims.signal.aborted ? [] : Array.from({ length: options.parallel }, (_, i) => slot(i + 1));

  // -------------------------------------------------------------- shutdown

  await new Promise<void>((resolve) => {
    if (stopClaims.signal.aborted) return resolve();
    stopClaims.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  if (running.size > 0) {
    const grace = fatal ? 0 : options.graceSeconds;
    log(`encerrando: aguardando ${running.size} tarefa(s) por até ${grace}s`);
    const graceOver = new AbortController();
    const finished = await Promise.race([
      Promise.all([...running]).then(() => true),
      sleep(grace * 1000, graceOver.signal).then(() => false),
    ]);
    graceOver.abort();
    if (!finished) {
      log(`tempo de espera esgotado: cancelando ${running.size} tarefa(s)`);
      cancelTasks.abort();
    }
  }
  await Promise.all(slots);
  signal.removeEventListener("abort", onSignal);
  const reason = fatal as FatalStop | null;
  if (reason) {
    log(reason.message);
    return reason.code;
  }
  log("worker encerrado");
  return EXIT_OK;
}
