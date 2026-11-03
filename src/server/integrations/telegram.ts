import "server-only";
import { z } from "zod";
import type { QuestionOption } from "@/lib/domain/types";
import { encodeAnswer, safeEqual, type AnswerRef } from "./security";

const TIMEOUT_MS = 15_000;
const MAX_BUTTON_TEXT = 60;
const MAX_MESSAGE = 4_000;
export const TELEGRAM_COMMAND = "/carbon";

async function telegramApi(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  // Never echo the URL: it contains the bot token.
  if (!response.ok || data.ok !== true) throw new Error(`Telegram: ${data.description ?? `HTTP ${response.status}`}`);
  return data.result;
}

export async function verifyTelegram(token: string): Promise<string> {
  const me = z.object({ username: z.string() }).parse(await telegramApi(token, "getMe", {}));
  return me.username;
}

/** Points Telegram at this machine's tunnel. Telegram then sends the secret in every request. */
export async function setTelegramWebhook(token: string, url: string, secret: string): Promise<void> {
  await telegramApi(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
}

export interface TelegramMessage {
  readonly chatId: string;
  readonly text: string;
  readonly replyTo?: number | null;
  readonly options?: readonly QuestionOption[];
  readonly answerRef?: Omit<AnswerRef, "optionIndex">;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One button per row so long labels stay readable on phones. */
export function telegramKeyboard(options: readonly QuestionOption[], ref: Omit<AnswerRef, "optionIndex">) {
  return {
    inline_keyboard: options.map((option, optionIndex) => [
      { text: clip(option.recommended ? `★ ${option.label}` : option.label, MAX_BUTTON_TEXT), callback_data: encodeAnswer({ ...ref, optionIndex }) },
    ]),
  };
}

export async function sendTelegram(token: string, message: TelegramMessage): Promise<void> {
  const hasButtons = message.options && message.options.length > 0 && message.answerRef;
  await telegramApi(token, "sendMessage", {
    chat_id: message.chatId,
    text: clip(message.text, MAX_MESSAGE),
    disable_web_page_preview: true,
    ...(message.replyTo ? { reply_parameters: { message_id: message.replyTo, allow_sending_without_reply: true } } : {}),
    ...(hasButtons && message.answerRef ? { reply_markup: telegramKeyboard(message.options ?? [], message.answerRef) } : {}),
  });
}

/** Acknowledges a button press and removes the buttons from that message. */
export async function acknowledgeTelegramAnswer(token: string, callbackId: string, chatId: string, messageId: number, text: string): Promise<void> {
  await telegramApi(token, "answerCallbackQuery", { callback_query_id: callbackId, text: clip(text, 190) });
  await telegramApi(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
}

export const verifyTelegramSecret = (header: string | null, secret: string): boolean => Boolean(secret && header && safeEqual(header, secret));

export type TelegramInbound =
  | { readonly kind: "task"; readonly chatId: string; readonly messageId: number; readonly user: string; readonly text: string }
  | { readonly kind: "answer"; readonly chatId: string; readonly messageId: number; readonly callbackId: string; readonly user: string; readonly value: string }
  | { readonly kind: "ignored" };

const userSchema = z.object({ first_name: z.string().optional(), username: z.string().optional() });
const updateSchema = z.object({
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({ id: z.number() }),
      from: userSchema.optional(),
      text: z.string().optional(),
      entities: z.array(z.object({ type: z.string(), offset: z.number(), length: z.number() })).optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: userSchema,
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
    })
    .optional(),
});

const displayName = (user: z.infer<typeof userSchema> | undefined): string => user?.username ? `@${user.username}` : (user?.first_name ?? "telegram");

/**
 * "/carbon <task>", "/carbon@bot <task>" or "@bot <task>" create a task; button presses answer
 * questions. botUsername is without "@".
 */
export function parseTelegramUpdate(raw: unknown, botUsername: string): TelegramInbound {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored" };
  const { message, callback_query: callback } = parsed.data;
  if (callback?.data && callback.message) {
    return { kind: "answer", chatId: String(callback.message.chat.id), messageId: callback.message.message_id, callbackId: callback.id, user: displayName(callback.from), value: callback.data };
  }
  if (!message?.text) return { kind: "ignored" };
  const bot = botUsername.toLowerCase();
  const trimmed = message.text.trim();
  const lower = trimmed.toLowerCase();
  const prefixes = [`${TELEGRAM_COMMAND}@${bot}`, TELEGRAM_COMMAND, `@${bot}`].filter((p) => p !== "@");
  const prefix = prefixes.find((p) => lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p}\n`));
  if (!prefix) return { kind: "ignored" };
  const text = trimmed.slice(prefix.length).trim();
  if (!text) return { kind: "ignored" };
  return { kind: "task", chatId: String(message.chat.id), messageId: message.message_id, user: displayName(message.from), text };
}
