import "server-only";
import { HttpError } from "../http";
import { AUTO_EFFORT, AUTO_MODEL, executionLabel, isValidEffort, resolveModel } from "@/lib/domain/models";
import { getSettings, type Settings } from "../repo/settings";
import { detectExecutors } from "../system/detect";
import { resolveExecutor, type ExecutorName } from "./resolve";

/** Picks the executor for a new task; 400 with a clear message if none can run it. */
export async function chooseExecutor(requested?: ExecutorName): Promise<ExecutorName> {
  const result = resolveExecutor(requested, getSettings().defaultExecutor, await detectExecutors());
  if (!result.ok) throw new HttpError(400, result.error);
  return result.executor;
}

/** The configured default model for an executor ("auto" when unset). */
export function defaultModelFor(executor: ExecutorName, settings: Settings): string {
  return (executor === "claude" ? settings.claudeModel : settings.codexModel) || AUTO_MODEL;
}

/** Requested effort if valid for the executor, else the configured default ("auto" when unset). */
export function effortFor(executor: ExecutorName, settings: Settings, requested?: string): string {
  if (requested && isValidEffort(executor, requested)) return requested;
  const fallback = executor === "claude" ? settings.claudeEffort : settings.codexEffort;
  return isValidEffort(executor, fallback) ? fallback : AUTO_EFFORT;
}

/** Planned label for a new task, with "auto" already resolved from its text. */
export function plannedLabel(executor: ExecutorName, model: string, effort: string, title: string, description: string): string {
  return executionLabel(executor, resolveModel(executor, model, title, description, effort));
}
