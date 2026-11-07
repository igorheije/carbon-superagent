/**
 * Domain types — ported from the dsh-superagent domain model
 * (Source → Trigger → Thread → Eval → Ticket → Assignment → Channel)
 * and extended with the execution pipeline, RAG and learning concepts.
 */

export const STAGES = [
  "intake",
  "plan",
  "research",
  "code",
  "test",
  "review",
  "deliver",
  "reflect",
] as const;

export type StageId = (typeof STAGES)[number];

export type SourceKind = "linear" | "github" | "jira" | "slack" | "telegram";

export type TicketStatus = "queued" | "running" | "waiting" | "done" | "failed";

/** Where a task runs: in the panel process, on a pool worker, or in an AgentCore session. */
export type TaskRuntime = "local" | "pool" | "agentcore";

export const TASK_RUNTIMES: readonly TaskRuntime[] = ["local", "pool", "agentcore"];

export interface TaskPlacement {
  readonly runtime: TaskRuntime;
  /** Worker holding the lease. */
  readonly workerId: string | null;
  /** For the UI. */
  readonly workerName: string | null;
  readonly agentcoreSessionId: string | null;
}

/** One execution of a task on a machine (local runner or worker), oldest first. */
export interface TicketRun {
  /** "esta máquina" for the local runner, else the worker's name. */
  readonly where: string;
  readonly isLocal: boolean;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** null while running; done | failed | waiting | lost | canceled once it ended. */
  readonly outcome: string | null;
}

export type AgentStatus = "idle" | "working" | "done";

export type LogLevel = "info" | "tool" | "ok" | "warn" | "think";

export interface LogLine {
  readonly id: number;
  readonly stage: StageId;
  readonly level: LogLevel;
  readonly text: string;
}

export interface PlanStep {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  /** Not done on purpose (with the agent's reason) or never confirmed by the agent. */
  readonly state?: "skipped" | "unconfirmed";
  readonly note?: string;
}

export interface DiffFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly snippet: readonly string[];
}

export type KnowledgeKind = "code" | "doc" | "ticket" | "lesson";

export interface RetrievalHit {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly ref: string;
  readonly score: number;
  readonly excerpt: string;
}

export interface ReviewFinding {
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  readonly text: string;
  readonly resolved: boolean;
}

export interface PullRequest {
  readonly number: number;
  readonly branch: string;
  readonly draft: boolean;
  /** Branch the PR targets. */
  readonly base?: string;
  readonly url?: string;
}

/** Where the task's changes live: an isolated git worktree on its own branch. */
export interface TicketWorkspace {
  readonly path: string;
  readonly branch: string;
  /** What the branch was created from (e.g. "main", "origin/develop", "(sem commits)"). */
  readonly base: string;
  /** Suggested PR target, or null when the repo has no branch to target. */
  readonly prBase: string | null;
  /** Short SHA of Carbon's commit, once delivered. */
  readonly commit: string | null;
  /** False once the worktree folder was removed after the task finished (the branch stays). */
  readonly isActive?: boolean;
  /** Local branch the task branch was merged into from the panel. */
  readonly mergedInto?: string | null;
  /** When the changes were applied to the project folder as uncommitted edits. */
  readonly appliedAt?: string | null;
}

export type PermissionStatus = "pending" | "allowed" | "denied" | "expired";

/** A tool the agent asked to use that needs a human decision (Claude Code permission prompt). */
export interface PermissionPrompt {
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
  readonly detail: string;
  readonly canRemember: boolean;
  readonly status: PermissionStatus;
  readonly decidedBy: string | null;
  readonly askedAt: string;
  /** Answered by policy/rule without a human. */
  readonly auto?: boolean;
}

/** One clickable answer the agent offered for a question (CARBON_OPTION). */
export interface QuestionOption {
  readonly label: string;
  readonly detail: string | null;
  readonly recommended: boolean;
}

/** A blocking question the agent asked (CARBON_QUESTION). Answering it resumes the run. */
export interface AgentQuestion {
  readonly id: string;
  readonly stage: StageId;
  readonly text: string;
  /** Choices offered by the agent; empty when it asked an open question. */
  readonly options?: readonly QuestionOption[];
  readonly askedAt: string;
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly answeredAt: string | null;
}

export type SubagentStatus = "running" | "done" | "failed";

/** A sub-agent the main agent delegated part of the task to (Claude Code Agent tool). */
export interface SubagentRun {
  readonly id: string;
  /** Short description the main agent gave the delegation. */
  readonly label: string;
  /** Sub-agent type (e.g. "general-purpose", "Explore"). */
  readonly agentType: string;
  readonly status: SubagentStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly toolCalls: number;
  /** Last tool the sub-agent used, for the live panel. */
  readonly lastActivity: string | null;
}

export interface Ticket {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly source: SourceKind;
  readonly repo: string;
  readonly requester: string;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly status: TicketStatus;
  /** Where the task runs; absent on snapshots from before distributed execution (= "local"). */
  readonly runtime?: TaskRuntime;
  /** Who claimed the current/last remote run, recorded on claim; absent on local and older tasks. */
  readonly placement?: TaskPlacement | null;
  /** "Seguir até o final sem pedir permissão": only blocked and high-risk actions still ask. */
  readonly autoApprove?: boolean;
  /** Execution history across machines (last few), attached by the live snapshot. */
  readonly runs?: readonly TicketRun[];
  readonly stage: StageId | null;
  readonly cursor: number;
  readonly totalEvents: number;
  readonly plan: readonly PlanStep[];
  readonly logs: readonly LogLine[];
  readonly hits: readonly RetrievalHit[];
  readonly diff: readonly DiffFile[];
  readonly findings: readonly ReviewFinding[];
  readonly tests: { readonly added: number; readonly passing: number; readonly total: number } | null;
  readonly pr: PullRequest | null;
  /** Set at intake; the commit is filled in at delivery. */
  readonly workspace?: TicketWorkspace | null;
  readonly tokens: number;
  /** Cost reported by the executor (Claude Code), summed over every run of the task. */
  readonly costUsd?: number;
  /** Wall-clock seconds the agent ran, summed over every run (resumes included). */
  readonly runSeconds?: number;
  /** Model actually used (alias or name + effort), set when the run starts. */
  readonly model: string | null;
  /** Permission prompts raised during the run (pending first in the panel). */
  readonly permissions?: readonly PermissionPrompt[];
  /** Questions the agent asked, answered or not. Answered ones are fed back as decisions. */
  readonly questions?: readonly AgentQuestion[];
  /** Agent session of the last run, used to resume after a question is answered. */
  readonly sessionId?: string | null;
  /** Set when a human answered the pending questions: the next run continues instead of starting over. */
  readonly resume?: boolean;
  /** The person allowed the agent to split the task across parallel sub-agents (Claude Code only). */
  readonly multiAgent?: boolean;
  /** Sub-agents started during the runs of this task, oldest first. */
  readonly subagents?: readonly SubagentRun[];
  /** The person allowed splitting this task into subtasks that run on other cluster machines. */
  readonly distributed?: boolean;
  /** Parent of a distributed task: the subtasks it was split into and where the fan-in stands. */
  readonly split?: SplitState;
  /** Subtask: the task it belongs to. */
  readonly parent?: { readonly id: string; readonly key: string; readonly title: string };
  /** Subtask: its brief and the files it owns. */
  readonly subtask?: SubtaskSpec;
  /** Branch a subtask starts from (its parent's branch) instead of the project base. */
  readonly baseBranch?: string;
  readonly startedAtTick: number | null;
  readonly endedAtTick: number | null;
}

/** One part of a distributed task, as declared by the agent with CARBON_SUBTASK. */
export interface SubtaskSpec {
  readonly title: string;
  readonly files: readonly string[];
  readonly brief: string;
}

export type MergeResult = "merged" | "conflict" | "failed" | "empty";

export interface SplitChild {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly files: readonly string[];
  readonly merge?: MergeResult;
}

export interface SplitState {
  /** running: subtasks working · integrating: parent queued to merge them · done: integration ran. */
  readonly phase: "running" | "integrating" | "done";
  readonly children: readonly SplitChild[];
  readonly createdAt: string;
}

export type LessonStatus = "candidate" | "promoted" | "discarded";

export interface Lesson {
  readonly id: string;
  readonly ticketKey: string;
  readonly rule: string;
  readonly evidence: string;
  readonly scope: string;
  readonly confidence: number;
  readonly status: LessonStatus;
}

export interface Metrics {
  readonly completed: number;
  readonly prsOpened: number;
  readonly tokens: number;
  readonly ticksPerTicket: readonly number[];
}

export type AcceptMode = "observe" | "act";

export interface EngineState {
  readonly tick: number;
  readonly running: boolean;
  readonly speedMs: number;
  readonly acceptMode: AcceptMode;
  readonly activeTicketId: string | null;
  readonly tickets: readonly Ticket[];
  readonly agents: Readonly<Record<StageId, AgentStatus>>;
  readonly lessons: readonly Lesson[];
  readonly metrics: Metrics;
  readonly nextLogId: number;
}
