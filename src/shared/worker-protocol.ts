import { z } from "zod";
import type { ExecutorEvent } from "./executors/events";
import { hostTelemetrySchema } from "./host-telemetry";

/**
 * Wire contract between the panel (/api/worker/*) and remote workers (pool machines and
 * AgentCore containers). Shared by both sides, so it must stay free of `server-only`, DB and
 * Next.js imports. Bump PROTOCOL_VERSION on any breaking change; the panel answers 426 to
 * workers that speak an older version.
 */
export const PROTOCOL_VERSION = 1;

/** Base label used when the project repo has no commit yet (same text as the local runner). */
export const NO_COMMITS_REF = "(sem commits)";

/** JSON request bodies above this size are rejected with 413. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const executorId = z.enum(["claude", "codex"]);
const shortText = z.string().max(200);
/** Host telemetry is best effort: an invalid snapshot is dropped, never a 400 that could cost a lease. */
const optionalHost = hostTelemetrySchema.optional().catch(undefined);

// ---------------------------------------------------------------- hello

export const helloRequestSchema = z.object({
  version: z.number().int().min(0),
  executors: z.array(executorId).max(2).default([]),
  git: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(64).default(1),
  /** Free-form worker build label (e.g. "0.3.0"), shown in the panel. */
  workerVersion: shortText.optional(),
  /** Additive: host snapshot for Configurações → Máquinas → Carga. Older workers omit it. */
  host: optionalHost,
});
export type HelloRequest = z.infer<typeof helloRequestSchema>;

export const helloResponseSchema = z.object({
  protocol: z.number().int(),
  leaseMs: z.number().int().positive(),
  pollMs: z.number().int().positive(),
  /** Optional for older panels: "active" when absent. paused/pending → claims return 204. */
  availability: z.enum(["active", "paused", "pending"]).optional(),
});
export type HelloResponse = z.infer<typeof helloResponseSchema>;

// ---------------------------------------------------------------- claim

export const claimRequestSchema = z.object({
  executors: z.array(executorId).min(1).max(2),
  host: optionalHost,
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

const modelChoiceSchema = z.object({
  model: z.string().max(80).nullable(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  label: z.string().max(200),
  reason: z.string().max(500),
});

const codeSourceSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("git"), remoteUrl: z.string().min(1).max(2000), baseRef: z.string().max(300), branch: z.string().max(300) }),
  z.object({ transport: z.literal("bundle"), baseRef: z.string().max(300), branch: z.string().max(300), bundleUrl: z.string().max(2000) }),
]);
export type CodeSource = z.infer<typeof codeSourceSchema>;

/** A pre-approved permission pattern ("always allow in this repo"), resolved by the panel. */
const permissionRuleSchema = z.object({ tool: z.string().max(200), pattern: z.string().max(2000) });
export type RemotePermissionRule = z.infer<typeof permissionRuleSchema>;

/**
 * A file the worker writes into its clone before running the agent (materialized skills,
 * .carbon/PROJECT_MAP.md, Claude memory). Paths are relative to the clone root; these files are
 * the same ones the local runner writes and are excluded from the agent's commit.
 */
const contextFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "caminho relativo sem .."),
  content: z.string(),
});
export type ContextFile = z.infer<typeof contextFileSchema>;

/** The slice of panel settings the worker needs to build the CLI command and answer prompts. */
const runSettingsSchema = z.object({
  permissionProfile: z.enum(["guarded", "auto", "unrestricted"]),
  isolateClaudeConfig: z.boolean(),
  approvalPolicy: z.enum(["ask", "smart", "autonomous"]),
});
export type RunSettings = z.infer<typeof runSettingsSchema>;

/** Everything a worker needs to run one task without touching the panel database. */
export const claimedTaskSchema = z.object({
  taskId: z.string(),
  key: z.string(),
  /**
   * Additive (T24a): task title, so remote commits read "feat: <título> (<KEY>)" like local ones.
   * Optional: a panel that predates it still produces valid claims (worker falls back to the key).
   */
  title: z.string().max(500).optional(),
  leaseMs: z.number().int().positive(),
  executor: executorId,
  model: modelChoiceSchema,
  prompt: z.string(),
  resume: z.object({ decisions: z.array(z.string()) }).nullable(),
  code: codeSourceSchema,
  limits: z.object({ maxRunMinutes: z.number().int().positive() }),
  permissionRules: z.array(permissionRuleSchema),
  /** Extension to design §2 (needed by buildCommand / auto-answers on the worker). */
  settings: runSettingsSchema,
  /** Extension to design §2: context files the local runner writes into the worktree. */
  files: z.array(contextFileSchema),
  /** Additive: "seguir sem pedir permissão" for this task (blocked/high-risk actions still ask). */
  autoApprove: z.boolean().optional(),
});
export type ClaimedTask = z.infer<typeof claimedTaskSchema>;

// ---------------------------------------------------------------- heartbeat

/** Additive: older workers send `{}`, which stays valid. */
export const heartbeatRequestSchema = z.object({ host: optionalHost });
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({ cancel: z.boolean() });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ---------------------------------------------------------------- events

const TEXT_MAX = 64_000;
const eventText = z.string().max(TEXT_MAX);

/** Mirrors ExecutorEvent (src/shared/executors/events.ts); the type check below keeps them in sync. */
export const executorEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string().max(200), model: z.string().max(200).nullable() }),
  z.object({ type: z.literal("text"), text: eventText }),
  z.object({ type: z.literal("thinking"), text: eventText }),
  z.object({ type: z.literal("tool"), name: z.string().max(200), summary: eventText, path: z.string().max(2000).nullable(), agentId: z.string().max(200).optional() }),
  z.object({ type: z.literal("subagent_start"), id: z.string().max(200), description: eventText, agentType: z.string().max(200), isBackground: z.boolean() }),
  z.object({ type: z.literal("subagent_progress"), id: z.string().max(200), toolCalls: z.number().int().min(0), lastTool: z.string().max(200) }),
  z.object({ type: z.literal("subagent_end"), id: z.string().max(200), isError: z.boolean() }),
  z.object({ type: z.literal("tool_done"), toolUseId: z.string().max(200), isError: z.boolean() }),
  z.object({ type: z.literal("plan"), items: z.array(z.object({ text: eventText, done: z.boolean() })).max(200) }),
  z.object({ type: z.literal("usage"), tokens: z.number().finite().min(0), costUsd: z.number().finite().min(0).nullable() }),
  z.object({ type: z.literal("result"), isError: z.boolean(), text: eventText }),
  z.object({ type: z.literal("error"), message: eventText }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string().max(200),
    tool: z.string().max(200),
    summary: eventText,
    detail: eventText,
    input: z.unknown(),
    suggestions: z.array(z.unknown()).max(50),
  }),
  z.object({ type: z.literal("permission_denied"), tool: z.string().max(200), message: eventText }),
]);

// Compile-time guard: parsed events are valid ExecutorEvents, and every event type has a schema.
type SchemaEvent = z.infer<typeof executorEventSchema>;
type Assert<T extends true> = T;
export type EventSchemaInSync = Assert<[SchemaEvent] extends [ExecutorEvent] ? ([ExecutorEvent["type"]] extends [SchemaEvent["type"]] ? true : false) : false>;

export const MAX_EVENTS_PER_BATCH = 500;

export const eventsRequestSchema = z.object({
  /** Monotonic batch number per task, starting at 1. Batches with seq <= the last accepted are ignored. */
  seq: z.number().int().min(1),
  events: z.array(executorEventSchema).max(MAX_EVENTS_PER_BATCH),
});
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

export const eventsResponseSchema = z.object({ acceptedSeq: z.number().int().min(0) });
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

// ---------------------------------------------------------------- result (route lands in T10)

export const resultRequestSchema = z.object({
  /**
   * "waiting" (RMT-02): the agent asked a CARBON_QUESTION. The panel parks the task until a human
   * answers, then requeues it on the same runtime; nothing is delivered for this run.
   */
  status: z.enum(["done", "failed", "canceled", "waiting"]),
  branch: z.string().max(300),
  commit: z.string().max(80).nullable(),
  transport: z.enum(["push", "bundle"]),
  error: z.string().max(4000).optional(),
});
export type ResultRequest = z.infer<typeof resultRequestSchema>;

// ---------------------------------------------------------------- permissions (RMT-01)

/** How a human (or the panel's timeout) answered a permission prompt the worker forwarded. */
export const permissionDecisionSchema = z.object({
  /** Monotonic per run of the task, starting at 1: the worker polls with ?after=<last seq>. */
  seq: z.number().int().min(1),
  requestId: z.string().max(200),
  behavior: z.enum(["allow", "deny"]),
  /** Text handed to the agent on deny (who denied it, or the timeout). */
  message: z.string().max(2000).nullable(),
  /** "allow everything for the rest of this task": the worker auto-allows later prompts. */
  allowTask: z.boolean(),
  /** "always allow in this repo": the new rule, so the worker stops asking for the same thing. */
  rule: permissionRuleSchema.nullable(),
});
export type PermissionDecisionWire = z.infer<typeof permissionDecisionSchema>;

export const permissionsResponseSchema = z.object({ decisions: z.array(permissionDecisionSchema).max(200) });
export type PermissionsResponse = z.infer<typeof permissionsResponseSchema>;

/** Error body codes the worker reacts to. */
export const LEASE_LOST = "lease_lost";

// ---------------------------------------------------------------- paths

const taskPath = (taskId: string) => `/api/worker/tasks/${encodeURIComponent(taskId)}`;

/** GET: git bundle of the task base · PUT: the worker's result bundle (application/octet-stream). */
export const bundlePath = (taskId: string) => `${taskPath(taskId)}/bundle`;

/** GET ?after=<seq>: long-poll of answered permission prompts (PermissionsResponse). */
export const permissionsPath = (taskId: string, after = 0) => `${taskPath(taskId)}/permissions?after=${Math.max(0, Math.floor(after))}`;

/** POST: the task's final ResultRequest. */
export const resultPath = (taskId: string) => `${taskPath(taskId)}/result`;

// ---------------------------------------------------------------- agentcore

/**
 * POST, Authorization: Bearer <one-time task token from the Invoke payload>, body
 * AgentCoreClaimRequest → ClaimedTask. The token is burned here; afterwards it authenticates only
 * the task-scoped routes (/api/worker/tasks/<taskId>/*) of that same task, while it runs.
 */
export const AGENTCORE_CLAIM_PATH = "/api/worker/agentcore/claim";

export const agentcoreClaimRequestSchema = z.object({ taskId: z.string().min(1).max(200) });
export type AgentCoreClaimRequest = z.infer<typeof agentcoreClaimRequestSchema>;

// ---------------------------------------------------------------- cluster join

/**
 * POST, Authorization: Bearer <cluster join token cjt_…>, body JoinRequest → 201 JoinResponse.
 * Trades the shared join token for this node's own worker credential (cwk_…), returned once.
 */
export const JOIN_PATH = "/api/worker/join";
/** POST with the node credential: the node removes itself from the cluster (revokes its credential). */
export const LEAVE_PATH = "/api/worker/leave";

export const joinRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  hostname: z.string().trim().max(253).optional(),
  version: z.number().int().min(0),
  executors: z.array(executorId).max(2).default([]),
  git: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(64).default(1),
  workerVersion: shortText.optional(),
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const joinResponseSchema = z.object({
  nodeId: z.string().min(1),
  token: z.string().min(1),
  name: z.string(),
  availability: z.enum(["active", "paused", "pending"]),
});
export type JoinResponse = z.infer<typeof joinResponseSchema>;
