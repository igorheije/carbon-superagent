import { z } from "zod";
import type { ExecutorEvent } from "./executors/events";

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

// ---------------------------------------------------------------- hello

export const helloRequestSchema = z.object({
  version: z.number().int().min(0),
  executors: z.array(executorId).max(2).default([]),
  git: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(64).default(1),
  /** Free-form worker build label (e.g. "0.3.0"), shown in the panel. */
  workerVersion: shortText.optional(),
});
export type HelloRequest = z.infer<typeof helloRequestSchema>;

export const helloResponseSchema = z.object({
  protocol: z.number().int(),
  leaseMs: z.number().int().positive(),
  pollMs: z.number().int().positive(),
});
export type HelloResponse = z.infer<typeof helloResponseSchema>;

// ---------------------------------------------------------------- claim

export const claimRequestSchema = z.object({
  executors: z.array(executorId).min(1).max(2),
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
});
export type ClaimedTask = z.infer<typeof claimedTaskSchema>;

// ---------------------------------------------------------------- heartbeat

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
  z.object({ type: z.literal("tool"), name: z.string().max(200), summary: eventText, path: z.string().max(2000).nullable() }),
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
  status: z.enum(["done", "failed", "canceled"]),
  branch: z.string().max(300),
  commit: z.string().max(80).nullable(),
  transport: z.enum(["push", "bundle"]),
  error: z.string().max(4000).optional(),
});
export type ResultRequest = z.infer<typeof resultRequestSchema>;

/** Error body codes the worker reacts to. */
export const LEASE_LOST = "lease_lost";

// ---------------------------------------------------------------- paths

const taskPath = (taskId: string) => `/api/worker/tasks/${encodeURIComponent(taskId)}`;

/** GET: git bundle of the task base · PUT: the worker's result bundle (application/octet-stream). */
export const bundlePath = (taskId: string) => `${taskPath(taskId)}/bundle`;

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
