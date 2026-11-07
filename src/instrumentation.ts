const LEASE_SWEEP_MS = 15_000;

/** Remote tasks whose worker stopped renewing its lease fail (or go back to the queue). */
async function startLeaseSweeper(): Promise<void> {
  const globalForSweeper = globalThis as unknown as { carbonLeaseSweeper?: ReturnType<typeof setInterval> };
  if (globalForSweeper.carbonLeaseSweeper) return;
  const { recoverUnleasedRemoteTasks, sweepExpiredLeases } = await import("./server/runner/scheduler");
  const { getSettings } = await import("./server/repo/settings");
  const { notifyLive } = await import("./server/runner/live");
  const { failLostSessions } = await import("./server/runtimes/agentcore-store");
  // AgentCore sessions that never claimed their task within the deadline (also checked below).
  if (failLostSessions(Date.now()).length > 0) notifyLive();
  // Pool tasks whose delivery was cut by a restart have no lease left to expire: end them now.
  const stuck = recoverUnleasedRemoteTasks();
  if (stuck.length > 0) {
    console.warn(`[carbon] ${stuck.length} tarefa(s) remota(s) marcada(s) como falha: painel reiniciou durante a entrega`);
    notifyLive();
  }
  const timer = setInterval(() => {
    try {
      const changed = sweepExpiredLeases(Date.now(), { requeue: getSettings().workers.requeueOnLeaseLoss });
      const lost = failLostSessions(Date.now());
      if (changed.length + lost.length > 0) notifyLive();
    } catch (error) {
      console.error("[carbon] varredura de leases:", error instanceof Error ? error.message : String(error));
    }
  }, LEASE_SWEEP_MS);
  timer.unref();
  globalForSweeper.carbonLeaseSweeper = timer;
  await startSplitReconciler();
}

const SPLIT_RECONCILE_MS = 3_000;

/** Distributed tasks: queue a parent to integrate as soon as all its parts are final (also after a restart). */
async function startSplitReconciler(): Promise<void> {
  const globalForSplits = globalThis as unknown as { carbonSplitReconciler?: ReturnType<typeof setInterval> };
  if (globalForSplits.carbonSplitReconciler) return;
  const { reconcileSplits } = await import("./server/runner/split");
  const { kick } = await import("./server/runner/runner");
  const timer = setInterval(() => {
    try {
      if (reconcileSplits().length > 0) kick();
    } catch (error) {
      console.error("[carbon] reconciliação de tarefas distribuídas:", error instanceof Error ? error.message : String(error));
    }
  }, SPLIT_RECONCILE_MS);
  timer.unref();
  globalForSplits.carbonSplitReconciler = timer;
}

/** "Claude Code deste computador para os workers" survives restarts when left on. */
async function startClaudeShareIfEnabled(): Promise<void> {
  const { getSettings } = await import("./server/repo/settings");
  if (!getSettings().shareClaudeLogin) return;
  const { startClaudeShare } = await import("./server/claude-share");
  const status = await startClaudeShare();
  if (status.state === "error") console.warn(`[carbon] compartilhar Claude Code: ${status.error}`);
}

/** Boot hook: mark tasks interrupted by a restart as failed, then resume the queue. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { recoverInterruptedTasks } = await import("./server/repo/tasks");
  const { kick, shutdownRunner } = await import("./server/runner/runner");
  const { startIntegrations } = await import("./server/integrations/hub");
  startIntegrations();
  void startClaudeShareIfEnabled();
  const globalForShutdown = globalThis as unknown as { carbonShutdownHooked?: boolean };
  if (!globalForShutdown.carbonShutdownHooked) {
    globalForShutdown.carbonShutdownHooked = true;
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, () => {
        shutdownRunner();
        // Give the agent's process group a moment to receive the signal before Next exits.
        setTimeout(() => process.exit(0), 300).unref();
      });
    }
  }
  const { listProjects } = await import("./server/repo/projects");
  const { seedBuiltinSkills } = await import("./server/repo/skills");
  const { getOverview } = await import("./server/knowledge/store");
  const { indexRepository } = await import("./server/knowledge/indexer");
  try {
    recoverInterruptedTasks();
    // New built-in skills reach this install right away, not only when the Skills page opens.
    seedBuiltinSkills();
    kick();
    await startLeaseSweeper();
    const { startAgentCoreDispatcher } = await import("./server/runtimes/agentcore");
    startAgentCoreDispatcher();
    // Worktrees left behind by finished tasks go away; their branches stay in the repo.
    const { releaseFinishedWorktrees } = await import("./server/runner/cleanup");
    void releaseFinishedWorktrees()
      .then((n) => n > 0 && console.log(`[carbon] ${n} worktree(s) de tarefas terminadas removido(s); branches preservados`))
      .catch((error: unknown) => console.error("[carbon] limpeza de worktrees:", error instanceof Error ? error.message : String(error)));
    // Projects without an index (new install or upgraded schema) get mapped in the background.
    for (const project of listProjects()) {
      if (!getOverview(project.id)) void indexRepository({ id: project.id, repoPath: project.repoPath }, { withSummary: false, executor: null });
    }
  } catch (error) {
    console.error("[carbon] boot recovery failed:", error instanceof Error ? error.message : String(error));
  }
}
