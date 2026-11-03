import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { adfToText, mapJiraPriority, parseJiraWebhook, textToAdf, verifyJiraWebhook } from "./jira";
import { eventLine, prUrlOf, titleFrom } from "./messages";
import { decodeAnswer, encodeAnswer, hmacSha256Hex } from "./security";
import { parseSlackRequest, questionBlocks, stripSlackMentions, verifySlackSignature } from "./slack";
import { parseTelegramUpdate, telegramKeyboard, verifyTelegramSecret } from "./telegram";

const TASK_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("answer tokens", () => {
  it("round-trips and fits Telegram's 64-byte callback_data", () => {
    const token = encodeAnswer({ taskId: TASK_ID, questionIndex: 1, optionIndex: 3 });
    expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
    expect(decodeAnswer(token)).toEqual({ taskId: TASK_ID, questionIndex: 1, optionIndex: 3 });
  });

  it("rejects tampered or foreign values", () => {
    expect(decodeAnswer(`a|not-a-uuid|0|0`)).toBeNull();
    expect(decodeAnswer(`a|${TASK_ID}|-1|0`)).toBeNull();
    expect(decodeAnswer(`x|${TASK_ID}|0|0`)).toBeNull();
    expect(decodeAnswer(`a|${TASK_ID}|0|99`)).toBeNull();
  });
});

describe("Slack", () => {
  const secret = "s3cr3t";
  const body = "token=x&payload=%7B%7D";
  const now = 1_800_000_000;
  const sign = (ts: number, raw = body) => `v0=${hmacSha256Hex(secret, `v0:${ts}:${raw}`)}`;

  it("accepts a valid v0 signature and rejects stale, forged or unsigned requests", () => {
    expect(verifySlackSignature(body, String(now), sign(now), secret, now)).toBe(true);
    expect(verifySlackSignature(body, String(now - 600), sign(now - 600), secret, now)).toBe(false);
    expect(verifySlackSignature(`${body}x`, String(now), sign(now), secret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now), null, secret, now)).toBe(false);
    expect(verifySlackSignature(body, String(now), sign(now), "", now)).toBe(false);
  });

  it("parses url verification, mentions and button clicks", () => {
    expect(parseSlackRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }), "application/json")).toEqual({ kind: "challenge", challenge: "abc" });
    const mention = { type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "17.1", user: "U9", text: "<@UBOT> corrige o login" } };
    expect(parseSlackRequest(JSON.stringify(mention), "application/json")).toEqual({ kind: "mention", channel: "C1", ts: "17.1", user: "U9", text: "corrige o login" });
    const fromBot = { ...mention, event: { ...mention.event, bot_id: "B1" } };
    expect(parseSlackRequest(JSON.stringify(fromBot), "application/json").kind).toBe("ignored");
    const payload = { type: "block_actions", user: { id: "U9", username: "ana" }, channel: { id: "C1" }, response_url: "https://hooks.slack.com/actions/x", actions: [{ action_id: "carbon_answer_0", value: "a|v" }] };
    expect(parseSlackRequest(`payload=${encodeURIComponent(JSON.stringify(payload))}`, "application/x-www-form-urlencoded")).toEqual({
      kind: "answer", value: "a|v", user: "ana", channel: "C1", responseUrl: "https://hooks.slack.com/actions/x",
    });
  });

  it("builds one button per option with the encoded answer", () => {
    const blocks = questionBlocks("❓ FRG-1", "Qual repo?", [{ label: "leolegends/ig", detail: null, recommended: true }, { label: "outro", detail: null, recommended: false }], { taskId: TASK_ID, questionIndex: 0 }) as { type: string; elements?: { value: string; style?: string }[] }[];
    const buttons = blocks.find((b) => b.type === "actions")?.elements ?? [];
    expect(buttons).toHaveLength(2);
    expect(decodeAnswer(buttons[1]?.value ?? "")).toEqual({ taskId: TASK_ID, questionIndex: 0, optionIndex: 1 });
    expect(buttons[0]?.style).toBe("primary");
    expect(stripSlackMentions("<@U1|carbon>   faz   isso")).toBe("faz isso");
  });
});

describe("Telegram", () => {
  const message = (text: string) => ({ message: { message_id: 7, chat: { id: 42 }, from: { username: "ana" }, text } });

  it("creates tasks from /carbon and @bot, ignoring other chatter", () => {
    expect(parseTelegramUpdate(message("/carbon corrige o login"), "carbonbot")).toEqual({ kind: "task", chatId: "42", messageId: 7, user: "@ana", text: "corrige o login" });
    expect(parseTelegramUpdate(message("/carbon@CarbonBot ajusta o README"), "carbonbot")).toMatchObject({ kind: "task", text: "ajusta o README" });
    expect(parseTelegramUpdate(message("@carbonbot sobe o deploy"), "carbonbot")).toMatchObject({ kind: "task", text: "sobe o deploy" });
    expect(parseTelegramUpdate(message("bom dia"), "carbonbot").kind).toBe("ignored");
    expect(parseTelegramUpdate(message("/carbon"), "carbonbot").kind).toBe("ignored");
    expect(parseTelegramUpdate(message("/carbonara receita"), "carbonbot").kind).toBe("ignored");
  });

  it("parses button presses and checks the webhook secret", () => {
    const update = { callback_query: { id: "cb1", from: { first_name: "Ana" }, data: "a|x", message: { message_id: 9, chat: { id: 42 } } } };
    expect(parseTelegramUpdate(update, "carbonbot")).toEqual({ kind: "answer", chatId: "42", messageId: 9, callbackId: "cb1", user: "Ana", value: "a|x" });
    expect(verifyTelegramSecret("abc", "abc")).toBe(true);
    expect(verifyTelegramSecret("abd", "abc")).toBe(false);
    expect(verifyTelegramSecret(null, "abc")).toBe(false);
    expect(verifyTelegramSecret("", "")).toBe(false);
    const keyboard = telegramKeyboard([{ label: "A", detail: null, recommended: true }], { taskId: TASK_ID, questionIndex: 0 });
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe("★ A");
  });
});

describe("Jira", () => {
  const secret = "jira-secret";
  const body = JSON.stringify({ webhookEvent: "jira:issue_created" });

  it("verifies HMAC header or query secret", () => {
    expect(verifyJiraWebhook(body, `sha256=${hmacSha256Hex(secret, body)}`, null, secret)).toBe(true);
    expect(verifyJiraWebhook(body, "sha256=00", null, secret)).toBe(false);
    expect(verifyJiraWebhook(body, null, secret, secret)).toBe(true);
    expect(verifyJiraWebhook(body, null, "wrong", secret)).toBe(false);
    expect(verifyJiraWebhook(body, null, null, secret)).toBe(false);
    expect(verifyJiraWebhook(body, null, "", "")).toBe(false);
  });

  it("triggers on new issues with the label, on the label being added and on /carbon comments", () => {
    const created = { webhookEvent: "jira:issue_created", user: { displayName: "Ana" }, issue: { key: "API-7", fields: { labels: ["Carbon"] } } };
    expect(parseJiraWebhook(created, "carbon")).toEqual({ kind: "issue", key: "API-7", requester: "Ana" });
    expect(parseJiraWebhook({ ...created, issue: { key: "API-7", fields: { labels: ["outro"] } } }, "carbon")).toBeNull();

    const labeled = { webhookEvent: "jira:issue_updated", issue: { key: "API-8", fields: { labels: ["carbon"] } }, changelog: { items: [{ field: "labels", toString: "backend carbon" }] } };
    expect(parseJiraWebhook(labeled, "carbon")).toMatchObject({ kind: "issue", key: "API-8" });
    const otherEdit = { ...labeled, changelog: { items: [{ field: "summary", toString: "x" }] } };
    expect(parseJiraWebhook(otherEdit, "carbon")).toBeNull();

    const comment = { webhookEvent: "comment_created", issue: { key: "API-9" }, comment: { author: { displayName: "Bia" }, body: textToAdf("/carbon adiciona testes de borda") } };
    expect(parseJiraWebhook(comment, "carbon")).toEqual({ kind: "comment", key: "API-9", requester: "Bia", instruction: "adiciona testes de borda" });
    expect(parseJiraWebhook({ ...comment, comment: { body: "só um comentário" } }, "carbon")).toBeNull();
  });

  it("converts ADF to text and maps priorities", () => {
    const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Olá " }, { type: "mention", attrs: { text: "@Ana" } }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] }] };
    expect(adfToText(adf)).toContain("Olá @Ana");
    expect(adfToText(adf)).toContain("- item");
    expect(mapJiraPriority("Highest")).toBe("urgent");
    expect(mapJiraPriority("Alta")).toBe("high");
    expect(mapJiraPriority("Low")).toBe("low");
    expect(mapJiraPriority(undefined)).toBe("medium");
  });
});

describe("messages", () => {
  const ticket = { key: "FRG-4", title: "README", model: "opus · high", logs: [{ id: 1, stage: "deliver", level: "ok", text: "PR https://github.com/o/r/pull/12 (draft · observe)" }] } as unknown as Ticket;

  it("formats lifecycle lines with the PR link", () => {
    expect(prUrlOf(ticket)).toBe("https://github.com/o/r/pull/12");
    expect(eventLine({ type: "done", taskId: "t", detail: "" }, ticket, null)).toContain("PR pronto para revisão: https://github.com/o/r/pull/12");
    expect(eventLine({ type: "failed", taskId: "t", detail: "timeout" }, ticket, "https://x.trycloudflare.com/")).toContain("falhou: timeout\nhttps://x.trycloudflare.com/");
    expect(eventLine({ type: "started", taskId: "t", detail: "começando" }, ticket, null)).toBe("▶️ FRG-4 · README\ncomeçou · opus · high");
  });

  it("uses the first non-empty line as title, clipped", () => {
    expect(titleFrom("\n  corrige o login  \nmais detalhes")).toBe("corrige o login");
    expect(titleFrom("x".repeat(200)).length).toBe(120);
  });
});
