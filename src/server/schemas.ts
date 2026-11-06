import { z } from "zod";
import { PERSONA_IDS } from "@/lib/domain/personas";
import { MIN_PASSWORD_LENGTH } from "./auth/password";
import { EXECUTORS, modelSchema } from "./repo/settings";

export const emailSchema = z.string().trim().toLowerCase().email("e-mail inválido").max(200);
export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `senha com ao menos ${MIN_PASSWORD_LENGTH} caracteres`).max(200);
export const personaSchema = z.enum(PERSONA_IDS);
export const nameSchema = z.string().trim().min(2, "nome muito curto").max(80);

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

export const setupSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  persona: personaSchema,
  executor: z.enum(EXECUTORS),
  repoPath: z.string().trim().min(1, "informe o repositório").max(1024),
  linearApiKey: z.string().trim().max(200).optional(),
  autoPush: z.boolean().default(false),
  aiSummary: z.boolean().default(true),
});

export const newUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  persona: personaSchema,
  role: z.enum(["admin", "member"]).default("member"),
});

export const profileSchema = z.object({ name: nameSchema, persona: personaSchema });

export const changePasswordSchema = z.object({ current: z.string().min(1).max(200), next: passwordSchema });

export const newTaskSchema = z.object({
  title: z.string().trim().min(3, "título muito curto").max(200),
  description: z.string().trim().max(12_000).default(""),
  executor: z.enum(EXECUTORS).optional(),
  model: modelSchema.optional(),
  effort: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
  /** Where the task runs; omitted = "local" (this machine). */
  runtime: z.enum(["local", "pool", "agentcore"]).optional(),
  /** Let the agent use parallel sub-agents when the task benefits (Claude Code only). */
  multiAgent: z.boolean().default(false),
  /** Let the agent split the task into parts that run on other cluster machines (the task itself runs here). */
  distributed: z.boolean().default(false),
});

export const skillBodySchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  personas: z.array(personaSchema).max(PERSONA_IDS.length).default([]),
});

export const skillPatchSchema = z.object({
  enabled: z.boolean().optional(),
  personas: z.array(personaSchema).max(PERSONA_IDS.length).optional(),
  description: z.string().optional(),
  body: z.string().optional(),
});

export const importSkillSchema = z.union([
  z.object({ url: z.string().url().max(2000), personas: z.array(personaSchema).default([]) }),
  z.object({ content: z.string().min(1).max(200_000), personas: z.array(personaSchema).default([]) }),
]);
