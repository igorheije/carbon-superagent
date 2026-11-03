import { after, NextResponse } from "next/server";
import { getSettings, type Settings } from "@/server/repo/settings";
import { announceQueued, answerFromIntegration, createIntegrationTask } from "@/server/integrations/hub";
import { titleFrom } from "@/server/integrations/messages";
import { decodeAnswer, parseJsonSafe, readWebhookBody } from "@/server/integrations/security";
import { acknowledgeTelegramAnswer, parseTelegramUpdate, sendTelegram, verifyTelegram, verifyTelegramSecret, type TelegramInbound } from "@/server/integrations/telegram";

export const dynamic = "force-dynamic";

const reply = (status: number, error: string | null = null) => NextResponse.json({ success: error === null, data: null, error }, { status });

/** Bot username per token, so "@bot ..." mentions can be recognized without calling getMe every time. */
const usernames = new Map<string, string>();
async function botUsername(token: string): Promise<string> {
  const cached = usernames.get(token);
  if (cached) return cached;
  const name = await verifyTelegram(token);
  usernames.set(token, name);
  return name;
}

async function handle(settings: Settings, inbound: TelegramInbound): Promise<void> {
  const token = settings.telegramBotToken;
  if (inbound.kind === "ignored") return;
  if (!settings.telegramChatId || inbound.chatId !== settings.telegramChatId) {
    // Not the authorized chat: only tell it its own id, so the admin can authorize it.
    if (inbound.kind === "task") {
      await sendTelegram(token, { chatId: inbound.chatId, replyTo: inbound.messageId, text: `Este chat ainda não está autorizado no Carbon.\nchat id: ${inbound.chatId}\nCole esse id em Configurações → Integrações → Telegram.` });
    }
    return;
  }
  if (inbound.kind === "answer") {
    const ref = decodeAnswer(inbound.value);
    const result = ref ? answerFromIntegration(ref, `${inbound.user} (Telegram)`) : { ok: false as const, error: "botão inválido" };
    await acknowledgeTelegramAnswer(token, inbound.callbackId, inbound.chatId, inbound.messageId, result.ok ? `✅ ${result.summary}` : `⚠️ ${result.error}`);
    if (result.ok) await sendTelegram(token, { chatId: inbound.chatId, replyTo: inbound.messageId, text: `✅ ${result.summary}. Continuando a tarefa.` });
    return;
  }
  const result = await createIntegrationTask({
    source: "telegram",
    sourceRef: `${inbound.chatId}|${inbound.messageId}`,
    key: null,
    title: titleFrom(inbound.text),
    description: `${inbound.text}\n\nPedido no Telegram por ${inbound.user}.`,
    requesterName: `${inbound.user} (Telegram)`,
    priority: "medium",
  });
  if (result.ok && result.created) return announceQueued(result.task);
  const text = result.ok ? `Já existe a tarefa ${result.task.key} para esta mensagem.` : `⚠️ Não consegui criar a tarefa: ${result.error}`;
  await sendTelegram(token, { chatId: inbound.chatId, replyTo: inbound.messageId, text });
}

/** Telegram Bot API webhook (messages and button presses). */
export async function POST(request: Request) {
  const raw = await readWebhookBody(request);
  if (raw === null) return reply(413, "payload grande demais");
  const settings = getSettings();
  if (!settings.telegramBotToken || !settings.telegramWebhookSecret) return reply(503, "integração com Telegram não configurada");
  if (!verifyTelegramSecret(request.headers.get("x-telegram-bot-api-secret-token"), settings.telegramWebhookSecret)) return reply(401, "segredo inválido");
  const body = parseJsonSafe(raw);
  if (body === undefined) return reply(400, "JSON inválido");
  after(async () => {
    try {
      await handle(settings, parseTelegramUpdate(body, await botUsername(settings.telegramBotToken)));
    } catch (error) {
      console.error("[carbon] telegram:", error instanceof Error ? error.message : String(error));
    }
  });
  return reply(200);
}
