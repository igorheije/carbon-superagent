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

export interface Ticket {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly source: SourceKind;
  readonly repo: string;
  readonly requester: string;
  readonly priority: "urgent" | "high" | "medium" | "low";
  readonly status: TicketStatus;
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
  readonly startedAtTick: number | null;
  readonly endedAtTick: number | null;
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
