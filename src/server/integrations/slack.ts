import "server-only";
import { z } from "zod";
import type { QuestionOption } from "@/lib/domain/types";
import { encodeAnswer, hmacSha256Hex, safeEqual, type AnswerRef } from "./security";

const SLACK_API = "https://slack.com/api";
const TIMEOUT_MS = 15_000;
/** Slack rejects signatures older than 5 minutes to stop replays; so do we. */
const MAX_SKEW_SECONDS = 5 * 60;
export const ANSWER_ACTION_ID = "carbon_answer";
const MAX_BUTTON_TEXT = 75;

async function slackApi(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Slack respondeu ${response.status}`);
  const data = (await response.json()) as Record<string, unknown>;
  if (data.ok !== true) throw new Error(`Slack: ${String(data.error ?? "erro")}`);
  return data;
}

export async function verifySlack(token: string): Promise<string> {
  const data = await slackApi(token, "auth.test", {});
  return `${String(data.user ?? "bot")} @ ${String(data.team ?? "workspace")}`;
}

export interface SlackMessage {
  readonly channel: string;
  readonly text: string;
  readonly blocks?: readonly unknown[];
  readonly threadTs?: string | null;
}

/** Posts a message; returns its ts (to thread replies under it). */
export async function postSlack(token: string, message: SlackMessage): Promise<string> {
  const data = await slackApi(token, "chat.postMessage", {
    channel: message.channel,
    text: message.text,
    ...(message.blocks ? { blocks: message.blocks } : {}),
    ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
    unfurl_links: false,
  });
  return String(data.ts ?? "");
}

/** Replaces the message a button was clicked on. Only Slack's own hooks host is accepted. */
export async function replyToSlackAction(responseUrl: string, text: string): Promise<void> {
  const url = new URL(responseUrl);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") throw new Error("response_url inesperada");
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Slack request signing v0: HMAC-SHA256 of "v0:{timestamp}:{body}". */
export function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null, signingSecret: string, nowSeconds: number): boolean {
  if (!signingSecret || !timestamp || !signature?.startsWith("v0=")) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;
  return safeEqual(signature, `v0=${hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`);
}

/** "<@U123> corrige o login" → "corrige o login". */
export const stripSlackMentions = (text: string): string => text.replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, "").replace(/\s+/g, " ").trim();

const clipButton = (text: string): string => (text.length > MAX_BUTTON_TEXT ? `${text.slice(0, MAX_BUTTON_TEXT - 1)}…` : text);

/** Question with one button per option (Block Kit). */
export function questionBlocks(header: string, question: string, options: readonly QuestionOption[], ref: Omit<AnswerRef, "optionIndex">): readonly unknown[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${header}*\n${question}` } },
    ...(options.length > 0
      ? [
          {
            type: "actions",
            elements: options.map((option, optionIndex) => ({
              type: "button",
              action_id: `${ANSWER_ACTION_ID}_${optionIndex}`,
              text: { type: "plain_text", text: clipButton(option.recommended ? `★ ${option.label}` : option.label) },
              value: encodeAnswer({ ...ref, optionIndex }),
              ...(option.recommended ? { style: "primary" } : {}),
            })),
          },
        ]
      : [{ type: "context", elements: [{ type: "mrkdwn", text: "Responda no painel do Carbon." }] }]),
  ];
}

export type SlackInbound =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "mention"; readonly channel: string; readonly ts: string; readonly user: string; readonly text: string }
  | { readonly kind: "answer"; readonly value: string; readonly user: string; readonly channel: string; readonly responseUrl: string }
  | { readonly kind: "ignored" };

const eventSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  event: z
    .object({ type: z.string(), channel: z.string().optional(), ts: z.string().optional(), thread_ts: z.string().optional(), user: z.string().optional(), text: z.string().optional(), bot_id: z.string().optional() })
    .optional(),
});

const actionSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string(), name: z.string().optional(), username: z.string().optional() }),
  channel: z.object({ id: z.string() }).optional(),
  response_url: z.string(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).min(1),
});

/** Events API (JSON) and interactivity (form-encoded "payload=") share one endpoint. */
export function parseSlackRequest(rawBody: string, contentType: string): SlackInbound {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const payload = new URLSearchParams(rawBody).get("payload");
    if (!payload) return { kind: "ignored" };
    const parsed = actionSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) return { kind: "ignored" };
    const action = parsed.data.actions.find((a) => a.action_id.startsWith(ANSWER_ACTION_ID));
    if (!action?.value) return { kind: "ignored" };
    const { user, channel, response_url } = parsed.data;
    return { kind: "answer", value: action.value, user: user.name ?? user.username ?? user.id, channel: channel?.id ?? "", responseUrl: response_url };
  }
  const parsed = eventSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return { kind: "ignored" };
  if (parsed.data.type === "url_verification" && parsed.data.challenge) return { kind: "challenge", challenge: parsed.data.challenge };
  const event = parsed.data.event;
  if (parsed.data.type !== "event_callback" || event?.type !== "app_mention" || event.bot_id) return { kind: "ignored" };
  const text = stripSlackMentions(event.text ?? "");
  if (!text || !event.channel || !event.ts) return { kind: "ignored" };
  return { kind: "mention", channel: event.channel, ts: event.thread_ts ?? event.ts, user: event.user ?? "slack", text };
}
