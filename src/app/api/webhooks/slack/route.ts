import { after, NextResponse } from "next/server";
import { getSettings, isSlackConfigured, type Settings } from "@/server/repo/settings";
import { findTask } from "@/server/repo/tasks";
import { announceQueued, answerFromIntegration, createIntegrationTask } from "@/server/integrations/hub";
import { titleFrom } from "@/server/integrations/messages";
import { decodeAnswer, readWebhookBody } from "@/server/integrations/security";
import { parseSlackRequest, postSlack, replyToSlackAction, verifySlackSignature, type SlackInbound } from "@/server/integrations/slack";

export const dynamic = "force-dynamic";

const reply = (status: number, error: string | null = null) => NextResponse.json({ success: error === null, data: null, error }, { status });

/** With a channel configured, only that channel may create tasks or answer (plus a task's own origin thread). */
const isChannelAllowed = (settings: Settings, channel: string, originChannel = ""): boolean =>
  !settings.slackChannelId || channel === settings.slackChannelId || (originChannel !== "" && channel === originChannel);

async function handleMention(settings: Settings, mention: Extract<SlackInbound, { kind: "mention" }>): Promise<void> {
  const result = await createIntegrationTask({
    source: "slack",
    sourceRef: `${mention.channel}|${mention.ts}`,
    key: null,
    title: titleFrom(mention.text),
    description: `${mention.text}\n\nPedido no Slack por <@${mention.user}>.`,
    requesterName: `<@${mention.user}> (Slack)`,
    priority: "medium",
  });
  if (result.ok && result.created) return announceQueued(result.task);
  const text = result.ok ? `Já existe a tarefa ${result.task.key} para esta mensagem.` : `⚠️ Não consegui criar a tarefa: ${result.error}`;
  await postSlack(settings.slackBotToken, { channel: mention.channel, text, threadTs: mention.ts }).catch(() => undefined);
}

async function handleAnswer(settings: Settings, answer: Extract<SlackInbound, { kind: "answer" }>): Promise<void> {
  const ref = decodeAnswer(answer.value);
  const task = ref ? findTask(ref.taskId) : null;
  const originChannel = task?.source === "slack" ? (task.sourceRef ?? "").split("|")[0] : "";
  const result = !ref
    ? { ok: false as const, error: "botão inválido" }
    : !isChannelAllowed(settings, answer.channel, originChannel)
      ? { ok: false as const, error: "este canal não pode responder tarefas do Carbon" }
      : answerFromIntegration(ref, `${answer.user} (Slack)`);
  await replyToSlackAction(answer.responseUrl, result.ok ? `✅ ${result.summary}. Continuando a tarefa.` : `⚠️ ${result.error}`);
}

/** Slack Events API (app_mention) and interactivity (buttons) on one URL. */
export async function POST(request: Request) {
  const raw = await readWebhookBody(request);
  if (raw === null) return reply(413, "payload grande demais");
  const settings = getSettings();
  if (!isSlackConfigured(settings)) return reply(503, "integração com Slack não configurada");
  const isSigned = verifySlackSignature(raw, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), settings.slackSigningSecret, Math.floor(Date.now() / 1000));
  if (!isSigned) return reply(401, "assinatura inválida");
  // Slack retries when we are slow; the first delivery already created the task.
  if (request.headers.get("x-slack-retry-num")) return new NextResponse(null, { status: 200 });

  let inbound: SlackInbound;
  try {
    inbound = parseSlackRequest(raw, request.headers.get("content-type") ?? "");
  } catch {
    return reply(400, "payload inválido");
  }
  if (inbound.kind === "challenge") return NextResponse.json({ challenge: inbound.challenge });
  if (inbound.kind === "mention" && isChannelAllowed(settings, inbound.channel)) {
    const mention = inbound;
    after(() => handleMention(settings, mention).catch((e) => console.error("[carbon] slack:", e instanceof Error ? e.message : e)));
  }
  if (inbound.kind === "answer") {
    const answer = inbound;
    after(() => handleAnswer(settings, answer).catch((e) => console.error("[carbon] slack:", e instanceof Error ? e.message : e)));
  }
  return new NextResponse(null, { status: 200 });
}
