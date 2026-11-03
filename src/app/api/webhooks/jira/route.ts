import { after, NextResponse } from "next/server";
import { getSettings, isJiraConfigured } from "@/server/repo/settings";
import { announceQueued, createIntegrationTask, jiraAuth } from "@/server/integrations/hub";
import { getJiraIssue, parseJiraWebhook, verifyJiraWebhook, type JiraTrigger } from "@/server/integrations/jira";
import { parseJsonSafe, readWebhookBody } from "@/server/integrations/security";

export const dynamic = "force-dynamic";

const reply = (status: number, error: string | null = null) => NextResponse.json({ success: error === null, data: null, error }, { status });

async function handleTrigger(trigger: JiraTrigger): Promise<void> {
  const settings = getSettings();
  try {
    const issue = await getJiraIssue(jiraAuth(settings), trigger.key);
    const instruction = trigger.kind === "comment" && trigger.instruction ? `\n\n## Pedido no comentário\n${trigger.instruction}` : "";
    const result = await createIntegrationTask({
      source: "jira",
      sourceRef: issue.key,
      key: issue.key,
      title: issue.title,
      description: `${issue.description}${instruction}\n\nJira: ${issue.url}`,
      requesterName: `${trigger.requester} (Jira)`,
      priority: issue.priority,
    });
    if (!result.ok) console.error(`[carbon] jira ${trigger.key}: ${result.error}`);
    else if (result.created) await announceQueued(result.task);
  } catch (error) {
    console.error(`[carbon] jira ${trigger.key}:`, error instanceof Error ? error.message : String(error));
  }
}

/** Jira Cloud webhook (admin webhook or Automation "Send web request"). */
export async function POST(request: Request) {
  const raw = await readWebhookBody(request);
  if (raw === null) return reply(413, "payload grande demais");
  const settings = getSettings();
  if (!settings.jiraWebhookSecret || !isJiraConfigured(settings)) return reply(503, "integração com Jira não configurada");
  const querySecret = new URL(request.url).searchParams.get("secret");
  if (!verifyJiraWebhook(raw, request.headers.get("x-hub-signature"), querySecret, settings.jiraWebhookSecret)) return reply(401, "assinatura inválida");
  const body = parseJsonSafe(raw);
  if (body === undefined) return reply(400, "JSON inválido");
  const trigger = parseJiraWebhook(body, settings.jiraTriggerLabel);
  if (trigger) after(() => handleTrigger(trigger));
  return reply(200);
}
