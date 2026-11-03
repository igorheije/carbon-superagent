import "server-only";
import { z } from "zod";
import type { Ticket } from "@/lib/domain/types";
import { hmacSha256Hex, safeEqual } from "./security";

const TIMEOUT_MS = 15_000;
const MAX_DESCRIPTION = 12_000;
export const JIRA_COMMAND = "/carbon";

export interface JiraAuth {
  readonly site: string;
  readonly email: string;
  readonly apiToken: string;
}

export interface JiraIssue {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly priority: Ticket["priority"];
  readonly url: string;
}

async function call(auth: JiraAuth, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`${auth.site}/rest/api/3${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64")}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new Error("Jira recusou o e-mail/API token");
  if (response.status === 404) throw new Error("Jira: recurso não encontrado (confira a URL do site e a chave da issue)");
  if (!response.ok) throw new Error(`Jira respondeu ${response.status}`);
  return response.status === 204 ? null : response.json();
}

/** Atlassian Document Format → plain text (paragraphs, lists, code, mentions). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.text ?? "@";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfToText).join("");
  if (n.type === "listItem") return `- ${inner.trim()}\n`;
  if (["paragraph", "heading", "codeBlock", "blockquote"].includes(n.type ?? "")) return `${inner}\n\n`;
  return inner;
}

const paragraph = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });

/** Plain text (blank-line separated) → ADF document for comments. */
export const textToAdf = (text: string) => ({ version: 1, type: "doc", content: text.split(/\n{2,}/).map((block) => paragraph(block.trim())) });

export function mapJiraPriority(name: string | null | undefined): Ticket["priority"] {
  const n = (name ?? "").toLowerCase();
  if (["highest", "blocker", "critical", "urgente", "mais alta"].some((p) => n.includes(p))) return "urgent";
  if (["high", "major", "alta"].some((p) => n.includes(p))) return "high";
  if (["low", "minor", "trivial", "baixa"].some((p) => n.includes(p))) return "low";
  return "medium";
}

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.unknown().optional(),
    priority: z.object({ name: z.string() }).nullable().optional(),
    labels: z.array(z.string()).optional(),
  }),
});

export function toJiraIssue(site: string, raw: unknown): JiraIssue {
  const issue = issueSchema.parse(raw);
  return {
    key: issue.key,
    title: issue.fields.summary,
    description: adfToText(issue.fields.description).trim().slice(0, MAX_DESCRIPTION),
    priority: mapJiraPriority(issue.fields.priority?.name),
    url: `${site}/browse/${issue.key}`,
  };
}

export async function verifyJira(auth: JiraAuth): Promise<string> {
  const me = z.object({ displayName: z.string() }).parse(await call(auth, "/myself"));
  return me.displayName;
}

export async function getJiraIssue(auth: JiraAuth, key: string): Promise<JiraIssue> {
  return toJiraIssue(auth.site, await call(auth, `/issue/${encodeURIComponent(key)}?fields=summary,description,priority,labels`));
}

export async function commentOnJira(auth: JiraAuth, key: string, text: string): Promise<void> {
  await call(auth, `/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: { body: textToAdf(text) } });
}

/**
 * Moves the issue to the status with this name (case-insensitive, by transition or target status).
 * Returns false when no such transition is available from the current status.
 */
export async function transitionJira(auth: JiraAuth, key: string, statusName: string): Promise<boolean> {
  if (!statusName) return false;
  const data = z
    .object({ transitions: z.array(z.object({ id: z.string(), name: z.string(), to: z.object({ name: z.string() }).optional() })) })
    .parse(await call(auth, `/issue/${encodeURIComponent(key)}/transitions`));
  const wanted = statusName.toLowerCase();
  const match = data.transitions.find((t) => t.to?.name.toLowerCase() === wanted || t.name.toLowerCase() === wanted);
  if (!match) return false;
  await call(auth, `/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: { transition: { id: match.id } } });
  return true;
}

/**
 * Jira Cloud admin webhooks sign with "X-Hub-Signature: sha256=<hex>" when a secret is set;
 * Jira Automation "Send web request" cannot sign, so a ?secret= query value is also accepted.
 */
export function verifyJiraWebhook(rawBody: string, signatureHeader: string | null, querySecret: string | null, secret: string): boolean {
  if (!secret) return false;
  if (signatureHeader?.startsWith("sha256=")) return safeEqual(signatureHeader.slice("sha256=".length), hmacSha256Hex(secret, rawBody));
  return querySecret !== null && safeEqual(querySecret, secret);
}

export type JiraTrigger =
  | { readonly kind: "issue"; readonly key: string; readonly requester: string }
  | { readonly kind: "comment"; readonly key: string; readonly requester: string; readonly instruction: string };

const webhookSchema = z.object({
  webhookEvent: z.string().optional(),
  user: z.object({ displayName: z.string().optional() }).optional(),
  issue: z
    .object({ key: z.string(), fields: z.object({ labels: z.array(z.string()).optional() }).partial().optional() })
    .optional(),
  comment: z.object({ body: z.unknown(), author: z.object({ displayName: z.string().optional() }).optional() }).optional(),
  changelog: z.object({ items: z.array(z.object({ field: z.string(), toString: z.string().nullable().optional() })) }).optional(),
});

/**
 * What a Jira webhook asks Carbon to do: an issue that has (or just got) the trigger label,
 * or a comment starting with /carbon. Anything else returns null.
 */
export function parseJiraWebhook(raw: unknown, triggerLabel: string): JiraTrigger | null {
  const parsed = webhookSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.issue) return null;
  const { webhookEvent = "", issue, comment, changelog, user } = parsed.data;
  const label = triggerLabel.toLowerCase();

  if (webhookEvent === "comment_created" && comment) {
    const text = (typeof comment.body === "string" ? comment.body : adfToText(comment.body)).trim();
    if (!text.toLowerCase().startsWith(JIRA_COMMAND)) return null;
    return { kind: "comment", key: issue.key, requester: comment.author?.displayName ?? "Jira", instruction: text.slice(JIRA_COMMAND.length).trim() };
  }
  if (webhookEvent !== "jira:issue_created" && webhookEvent !== "jira:issue_updated") return null;
  if (!label) return null;
  const hasLabel = (issue.fields?.labels ?? []).some((l) => l.toLowerCase() === label);
  const labelJustAdded = (changelog?.items ?? []).some((i) => i.field === "labels" && (i.toString ?? "").toLowerCase().split(/\s+/).includes(label));
  const isTriggered = webhookEvent === "jira:issue_created" ? hasLabel : labelJustAdded;
  return isTriggered ? { kind: "issue", key: issue.key, requester: user?.displayName ?? "Jira" } : null;
}
