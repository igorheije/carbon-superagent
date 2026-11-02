/** Boot hook: mark tasks interrupted by a restart as failed, then resume the queue. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { recoverInterruptedTasks } = await import("./server/repo/tasks");
  const { kick, shutdownRunner } = await import("./server/runner/runner");
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
  const { getOverview } = await import("./server/knowledge/store");
  const { indexRepository } = await import("./server/knowledge/indexer");
  try {
    recoverInterruptedTasks();
    kick();
    // Projects without an index (new install or upgraded schema) get mapped in the background.
    for (const project of listProjects()) {
      if (!getOverview(project.id)) void indexRepository({ id: project.id, repoPath: project.repoPath }, { withSummary: false, executor: null });
    }
  } catch (error) {
    console.error("[carbon] boot recovery failed:", error instanceof Error ? error.message : String(error));
  }
}
