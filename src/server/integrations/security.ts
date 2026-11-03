import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (false on any length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export const hmacSha256Hex = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload, "utf8").digest("hex");

/** Random secret for webhooks (URL- and header-safe). */
export const newWebhookSecret = (): string => randomBytes(24).toString("base64url");

/** Webhook bodies are small; anything bigger is rejected before parsing. */
export const MAX_WEBHOOK_BYTES = 512 * 1024;

/** Raw body as text (signatures are computed over the exact bytes), or null when too large. */
export async function readWebhookBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return null;
  const text = await request.text();
  return Buffer.byteLength(text, "utf8") > MAX_WEBHOOK_BYTES ? null : text;
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const ANSWER_PREFIX = "a";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INDEX = 20;

export interface AnswerRef {
  readonly taskId: string;
  readonly questionIndex: number;
  readonly optionIndex: number;
}

/** Compact button payload (fits Telegram's 64-byte callback_data). */
export const encodeAnswer = (ref: AnswerRef): string => `${ANSWER_PREFIX}|${ref.taskId}|${ref.questionIndex}|${ref.optionIndex}`;

export function decodeAnswer(value: string): AnswerRef | null {
  const [prefix, taskId = "", q = "", o = ""] = value.split("|");
  const questionIndex = Number(q);
  const optionIndex = Number(o);
  const isIndex = (n: number) => Number.isInteger(n) && n >= 0 && n < MAX_INDEX;
  if (prefix !== ANSWER_PREFIX || !UUID_RE.test(taskId) || !isIndex(questionIndex) || !isIndex(optionIndex)) return null;
  return { taskId, questionIndex, optionIndex };
}
