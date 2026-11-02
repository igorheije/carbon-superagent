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
  /** A permission prompt nobody answers is denied after this many minutes. */
  permissionTimeoutMinutes: z.number().int().min(1).max(120).default(15),
  /** smart: auto-approve low-risk actions inside the worktree; ask only for risky ones. */
  approvalPolicy: z.enum(["ask", "smart", "autonomous"]).default("smart"),
  maxRunMinutes: z.number().int().min(5).max(240).default(45),
  linearApiKey: z.string().trim().max(200).default(""),
});

export type Settings = z.infer<typeof settingsSchema>;

/** What the browser may see: secrets reduced to a boolean. */
export type PublicSettings = Omit<Settings, "linearApiKey"> & { readonly linearConfigured: boolean };

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
  const { linearApiKey, ...rest } = settings;
  return { ...rest, linearConfigured: linearApiKey.length > 0 };
}
