const LEASE_SWEEP_MS = 15_000;

/** Remote tasks whose worker stopped renewing its lease fail (or go back to the queue). */
async function startLeaseSweeper(): Promise<void> {
  const globalForSweeper = globalThis as unknown as { carbonLeaseSweeper?: ReturnType<typeof setInterval> };
  if (globalForSweeper.carbonLeaseSweeper) return;
  const { recoverUnleasedRemoteTasks, sweepExpiredLeases } = await import("./server/runner/scheduler");
  const { getSettings } = await import("./server/repo/settings");
  const { notifyLive } = await import("./server/runner/live");
  // Pool tasks whose delivery was cut by a restart have no lease left to expire: end them now.
  const stuck = recoverUnleasedRemoteTasks();
  if (stuck.length > 0) {
    console.warn(`[carbon] ${stuck.length} tarefa(s) remota(s) marcada(s) como falha: painel reiniciou durante a entrega`);
    notifyLive();
  }
  const timer = setInterval(() => {
    try {
      const changed = sweepExpiredLeases(Date.now(), { requeue: getSettings().workers.requeueOnLeaseLoss });
      if (changed.length > 0) notifyLive();
    } catch (error) {
      console.error("[carbon] varredura de leases:", error instanceof Error ? error.message : String(error));
    }
  }, LEASE_SWEEP_MS);
  timer.unref();
  globalForSweeper.carbonLeaseSweeper = timer;
}

/** Boot hook: mark tasks interrupted by a restart as failed, then resume the queue. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { recoverInterruptedTasks } = await import("./server/repo/tasks");
  const { kick, shutdownRunner } = await import("./server/runner/runner");
  const { startIntegrations } = await import("./server/integrations/hub");
  startIntegrations();
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
