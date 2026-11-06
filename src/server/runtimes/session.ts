import "server-only";

/**
 * AgentCore identifiers derived from the task id, so the dispatcher, the auth layer and the
 * recovery code agree without storing anything extra. Kept apart from agentcore.ts so the auth
 * module does not pull in the AWS SDK.
 */

/** AgentCore requires runtimeSessionId to have at least 33 characters. */
export const MIN_SESSION_ID_LENGTH = 33;
const SESSION_PREFIX = "carbon-task-";
/** Lease owner recorded for an AgentCore container (there is no row in `workers`). */
export const AGENTCORE_WORKER_PREFIX = "agentcore:";

/** Deterministic runtimeSessionId for a task: same task → same session, always ≥ 33 chars. */
export function agentcoreSessionId(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${SESSION_PREFIX}${safe}`.padEnd(MIN_SESSION_ID_LENGTH, "0");
}

/** Synthetic worker identity holding the lease of an AgentCore task. */
export function agentcoreWorkerId(taskId: string): string {
  return `${AGENTCORE_WORKER_PREFIX}${agentcoreSessionId(taskId)}`;
}
