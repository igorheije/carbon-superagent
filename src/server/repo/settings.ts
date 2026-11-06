import "server-only";
import { z } from "zod";
import { AUTO_EFFORT, AUTO_MODEL, isValidModelName } from "@/lib/domain/models";
import { getDb } from "../db";

export const EXECUTORS = ["claude", "codex"] as const;
export type ExecutorId = (typeof EXECUTORS)[number];

/**
 * permissionProfile:
 * - guarded: Claude acceptEdits + allowlisted shell; Codex workspace-write sandbox.
 * - auto: Claude "auto" permission mode (classifier-approved); Codex workspace-write.
 * - unrestricted: bypass all checks. Only for throwaway machines/containers.
 */
/** "auto" | "default" | "" (legacy = CLI default) | a safe model name. */
export const modelSchema = z
  .string()
  .trim()
  .max(80)
  .refine((v) => v === "" || v === AUTO_MODEL || v === "default" || isValidModelName(v), "nome de modelo inválido");

/** Remote workers (pool machines / AgentCore). */
export const workersSettingsSchema = z.object({
  /** How long a claim lasts without a heartbeat. */
  leaseMs: z.number().int().min(10_000).max(600_000).default(60_000),
  /** Long-poll wait the worker uses between claims. */
  pollMs: z.number().int().min(1_000).max(60_000).default(25_000),
  /** true → a task whose worker vanished goes back to the queue; false → it fails. */
  requeueOnLeaseLoss: z.boolean().default(false),
  maxBundleMb: z.number().int().min(1).max(2_000).default(200),
});
export type WorkersSettings = z.infer<typeof workersSettingsSchema>;
const WORKERS_DEFAULTS: WorkersSettings = { leaseMs: 60_000, pollMs: 25_000, requeueOnLeaseLoss: false, maxBundleMb: 200 };

/** ARN of an AgentCore Runtime: arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>. */
export const AGENTCORE_RUNTIME_ARN = /^arn:aws(-[a-z]+)*:bedrock-agentcore:[a-z]{2}(-[a-z]+)+-\d:\d{12}:runtime\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** AgentCore Runtime (experimental, decision U5: implemented, never deployed by Carbon itself). */
export const agentcoreSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "região AWS inválida (ex.: sa-east-1)")
    .default("sa-east-1"),
  runtimeArn: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || AGENTCORE_RUNTIME_ARN.test(v), "ARN inválido: use arn:aws:bedrock-agentcore:<região>:<conta>:runtime/<id>")
    .default(""),
  /** Endpoint name of the runtime ("DEFAULT" when the runtime has no custom endpoint). */
  qualifier: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9_-]*$/, "qualifier com letras, números, _ ou -")
    .default("DEFAULT"),
  /** Simultaneous AgentCore sessions (cost control). */
  maxConcurrent: z.number().int().min(1).max(20).default(3),
});
export type AgentCoreSettings = z.infer<typeof agentcoreSettingsSchema>;
const AGENTCORE_DEFAULTS: AgentCoreSettings = { enabled: false, region: "sa-east-1", runtimeArn: "", qualifier: "DEFAULT", maxConcurrent: 3 };

const httpsUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), "use uma URL https://")
  .transform((v) => v.replace(/\/+$/, ""));

export const settingsSchema = z.object({
  repoPath: z.string().trim().max(1024).default(""),
  baseBranch: z.string().trim().max(200).default(""),
  defaultExecutor: z.enum(EXECUTORS).default("claude"),
  permissionProfile: z.enum(["guarded", "auto", "unrestricted"]).default("guarded"),
  acceptMode: z.enum(["observe", "act"]).default("observe"),
  autoPush: z.boolean().default(false),
  claudeModel: modelSchema.default(AUTO_MODEL),
  codexModel: modelSchema.default(AUTO_MODEL),
  claudeEffort: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).default(AUTO_EFFORT),
  codexEffort: z.enum(["auto", "low", "medium", "high"]).default(AUTO_EFFORT),
  /** Run a read-only AI pass after indexing to describe what the project does. */
  aiProjectSummary: z.boolean().default(true),
  /** Skip the user's personal Claude settings/hooks/MCP in runs (project settings still apply). */
  isolateClaudeConfig: z.boolean().default(true),
  /**
   * Inject the repository's Claude Code memory (from the machine user running Carbon) into each run.
   * Every portal account then gets that one person's memory, so it is off by default.
   */
  useClaudeMemory: z.boolean().default(false),
  /** A permission prompt nobody answers is denied after this many minutes. */
  permissionTimeoutMinutes: z.number().int().min(1).max(120).default(15),
  /** smart: auto-approve low-risk actions inside the worktree; ask only for risky ones. */
  approvalPolicy: z.enum(["ask", "smart", "autonomous"]).default("smart"),
  maxRunMinutes: z.number().int().min(5).max(240).default(45),
  linearApiKey: z.string().trim().max(200).default(""),

  /** Public HTTPS URL of a tunnel to this machine (Cloudflare Tunnel, ngrok), used for webhooks. */
  publicBaseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), "use uma URL https://")
    .transform((v) => v.replace(/\/+$/, ""))
    .default(""),
  /** Project that receives tasks created from Jira, Slack or Telegram ("" = first project). */
  integrationProjectId: z.string().trim().max(100).default(""),

  jiraSite: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(v.replace(/\/+$/, "")), "use https://<sua-empresa>.atlassian.net")
    .transform((v) => v.replace(/\/+$/, ""))
    .default(""),
  jiraEmail: z.string().trim().max(200).default(""),
  jiraApiToken: z.string().trim().max(400).default(""),
  jiraWebhookSecret: z.string().trim().max(200).default(""),
  /** Issues with this label (or a "/carbon" comment) become Carbon tasks. */
  jiraTriggerLabel: z.string().trim().max(60).default("carbon"),
  jiraStatusStarted: z.string().trim().max(60).default("Em andamento"),
  jiraStatusReview: z.string().trim().max(60).default("Em revisão"),

  slackBotToken: z.string().trim().max(300).default(""),
  slackSigningSecret: z.string().trim().max(200).default(""),
  slackChannelId: z.string().trim().max(40).default(""),

  telegramBotToken: z.string().trim().max(200).default(""),
  telegramWebhookSecret: z.string().trim().max(256).default(""),
  /** Only this chat may create tasks and answer questions. */
  telegramChatId: z.string().trim().max(40).default(""),

  workers: workersSettingsSchema.default(WORKERS_DEFAULTS),
  /** HTTPS URL where remote workers and AgentCore containers reach this panel (/api/worker/*). */
  panelPublicUrl: httpsUrl.default(""),
  agentcore: agentcoreSettingsSchema.default(AGENTCORE_DEFAULTS),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Never sent to the browser. In PUT, "" keeps the stored value and "-" clears it. */
export const SECRET_KEYS = [
  "linearApiKey",
  "jiraApiToken",
  "jiraWebhookSecret",
  "slackBotToken",
  "slackSigningSecret",
  "telegramBotToken",
  "telegramWebhookSecret",
] as const satisfies readonly (keyof Settings)[];

type SecretKey = (typeof SECRET_KEYS)[number];

/** What the browser may see: secrets reduced to booleans. */
export type PublicSettings = Omit<Settings, SecretKey> & {
  readonly linearConfigured: boolean;
  readonly jiraConfigured: boolean;
  readonly jiraWebhookSecretSet: boolean;
  readonly slackConfigured: boolean;
  readonly telegramConfigured: boolean;
};

export const isJiraConfigured = (s: Settings): boolean => Boolean(s.jiraSite && s.jiraEmail && s.jiraApiToken);
export const isSlackConfigured = (s: Settings): boolean => Boolean(s.slackBotToken && s.slackSigningSecret);
export const isTelegramConfigured = (s: Settings): boolean => Boolean(s.telegramBotToken && s.telegramChatId);

const SETTINGS_KEY = "settings";

export function getSettings(): Settings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
  let raw: unknown = {};
  try {
    raw = row ? JSON.parse(row.value) : {};
  } catch {
    raw = {};
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = settingsSchema.parse({ ...getSettings(), ...patch });
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function toPublicSettings(settings: Settings): PublicSettings {
  const safe = Object.fromEntries(Object.entries(settings).filter(([key]) => !(SECRET_KEYS as readonly string[]).includes(key))) as Omit<Settings, SecretKey>;
  return {
    ...safe,
    linearConfigured: settings.linearApiKey.length > 0,
    jiraConfigured: isJiraConfigured(settings),
    jiraWebhookSecretSet: settings.jiraWebhookSecret.length > 0,
    slackConfigured: isSlackConfigured(settings),
    telegramConfigured: isTelegramConfigured(settings),
  };
}
