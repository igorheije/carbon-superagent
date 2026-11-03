import "server-only";
import { answerFromOption, optionsOf, pendingQuestionsOf, questionsOf } from "@/lib/domain/questions";
import type { Ticket } from "@/lib/domain/types";
import { chooseExecutor, defaultModelFor, effortFor, plannedLabel } from "../executors/choose";
import { findProject, listProjects } from "../repo/projects";
import { getSettings, isJiraConfigured, isSlackConfigured, isTelegramConfigured, type Settings } from "../repo/settings";
import { createTask, findTask, findTaskBySource, type Task, type TaskSource } from "../repo/tasks";
import { listUsers } from "../repo/users";
import { answerTaskQuestion, kick, notifyChange, runnerEvents, TASK_EVENT, type TaskEvent } from "../runner/runner";
import { commentOnJira, transitionJira, type JiraAuth } from "./jira";
import { eventLine, queuedLine } from "./messages";
import type { AnswerRef } from "./security";
import { postSlack, questionBlocks } from "./slack";
import { sendTelegram } from "./telegram";

const LIVE = new Set(["queued", "running", "waiting"]);

const log = (scope: string, error: unknown) =>
  console.error(`[carbon] ${scope}:`, error instanceof Error ? error.message : String(error));

export const jiraAuth = (s: Settings): JiraAuth => ({ site: s.jiraSite, email: s.jiraEmail, apiToken: s.jiraApiToken });
const panelUrl = (s: Settings): string | null => (s.publicBaseUrl ? `${s.publicBaseUrl}/` : null);

/* ── creating tasks from Jira, Slack and Telegram ─────────────────────────── */

export interface IntegrationTaskInput {
  readonly source: Exclude<TaskSource, "manual" | "linear" | "github">;
  readonly sourceRef: string;
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly requesterName: string;
  readonly priority: Ticket["priority"];
}

export type IntegrationTaskResult = { readonly ok: true; readonly task: Task; readonly created: boolean } | { readonly ok: false; readonly error: string };

/**
 * Creates the task in the integration project, owned by the first admin, unless a live task
 * already exists for the same external item (Jira retries and repeated mentions are common).
 */
export async function createIntegrationTask(input: IntegrationTaskInput): Promise<IntegrationTaskResult> {
  const existing = findTaskBySource(input.source, input.sourceRef);
  if (existing && LIVE.has(existing.status)) return { ok: true, task: existing, created: false };

  const settings = getSettings();
  const project = (settings.integrationProjectId && findProject(settings.integrationProjectId)) || listProjects()[0];
  if (!project) return { ok: false, error: "nenhum projeto cadastrado no Carbon" };
  const owner = listUsers().find((u) => u.role === "admin");
  if (!owner) return { ok: false, error: "nenhum administrador cadastrado no Carbon" };

  let executor: Awaited<ReturnType<typeof chooseExecutor>>;
  try {
    executor = await chooseExecutor();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "nenhum agente disponível" };
  }
  const model = defaultModelFor(executor, settings);
  const effort = effortFor(executor, settings);
  const task = createTask({
    projectId: project.id,
    key: input.key,
    title: input.title,
    description: input.description,
    source: input.source,
    sourceRef: input.sourceRef,
    requesterId: owner.id,
    requesterName: input.requesterName,
    persona: owner.persona,
    executor,
    model,
    effort,
    modelLabel: plannedLabel(executor, model, effort, input.title, input.description),
    priority: input.priority,
    repo: project.name,
  });
  notifyChange();
  kick();
  return { ok: true, task, created: true };
}

/* ── answering questions from buttons ─────────────────────────────────────── */

export type IntegrationAnswer = { readonly ok: true; readonly summary: string } | { readonly ok: false; readonly error: string };

export function answerFromIntegration(ref: AnswerRef, who: string): IntegrationAnswer {
  const task = findTask(ref.taskId);
  if (!task) return { ok: false, error: "tarefa não encontrada" };
  const question = questionsOf(task.snapshot)[ref.questionIndex];
  if (!question) return { ok: false, error: "pergunta não encontrada" };
  if (question.answer !== null) return { ok: false, error: `já respondida por ${question.answeredBy ?? "alguém"}: ${question.answer}` };
  const option = optionsOf(question)[ref.optionIndex];
  if (!option) return { ok: false, error: "opção não encontrada" };
  const result = answerTaskQuestion(task.id, question.id, answerFromOption(option), who);
  return result.ok ? { ok: true, summary: `${task.key}: ${who} escolheu “${option.label}”` } : { ok: false, error: result.error ?? "não foi possível responder" };
}

/* ── notifying channels about the task lifecycle ──────────────────────────── */

/** First Slack message per task, so later updates thread under it (in memory: a restart starts a new thread). */
const slackThreads = new Map<string, string>();

/** "C123|1700.01" → channel + ts of the message that created the task. */
const splitRef = (ref: string | null): [string, string] => {
  const [a = "", b = ""] = (ref ?? "").split("|");
  return [a, b];
};

async function notifySlack(settings: Settings, task: Task, text: string, blocks?: readonly unknown[]) {
  const [originChannel, originTs] = task.source === "slack" ? splitRef(task.sourceRef) : ["", ""];
  const channel = originChannel || settings.slackChannelId;
  if (!channel) return;
  const threadTs = originTs || slackThreads.get(task.id) || null;
  const ts = await postSlack(settings.slackBotToken, { channel, text, blocks, threadTs });
  if (!threadTs && ts) slackThreads.set(task.id, ts);
}

async function notifyTelegram(settings: Settings, task: Task, text: string, ticket: Ticket, withQuestions: boolean) {
  const [originChat, originMessage] = task.source === "telegram" ? splitRef(task.sourceRef) : ["", ""];
  const chatId = originChat || settings.telegramChatId;
  const replyTo = Number(originMessage) || null;
  if (!withQuestions) return sendTelegram(settings.telegramBotToken, { chatId, text, replyTo });
  const all = questionsOf(ticket);
  for (const question of pendingQuestionsOf(ticket)) {
    await sendTelegram(settings.telegramBotToken, {
      chatId,
      replyTo,
      text: `${text}\n\n${question.text}`,
      options: optionsOf(question),
      answerRef: { taskId: task.id, questionIndex: all.indexOf(question) },
    });
  }
}

function questionsSlackBlocks(task: Task, ticket: Ticket, header: string): readonly unknown[] {
  const all = questionsOf(ticket);
  return pendingQuestionsOf(ticket).flatMap((q) => questionBlocks(header, q.text, optionsOf(q), { taskId: task.id, questionIndex: all.indexOf(q) }));
}

async function notifyJira(settings: Settings, task: Task, event: TaskEvent, text: string | null, ticket: Ticket) {
  if (task.source !== "jira" || !task.sourceRef) return;
  const auth = jiraAuth(settings);
  if (event.type === "started" && settings.jiraStatusStarted) {
    const moved = await transitionJira(auth, task.sourceRef, settings.jiraStatusStarted);
    if (!moved) log("jira", `sem transição para "${settings.jiraStatusStarted}" em ${task.sourceRef}`);
  }
  if (event.type === "done" && settings.jiraStatusReview) {
    const moved = await transitionJira(auth, task.sourceRef, settings.jiraStatusReview);
    if (!moved) log("jira", `sem transição para "${settings.jiraStatusReview}" em ${task.sourceRef}`);
  }
  if (event.type === "started" || !text) return;
  const questions =
    event.type === "question"
      ? pendingQuestionsOf(ticket)
          .map((q) => `${q.text}\n\n${optionsOf(q).map((o) => `• ${o.label}${o.recommended ? " (recomendado)" : ""}`).join("\n")}`)
          .join("\n\n")
      : "";
  await commentOnJira(auth, task.sourceRef, `Carbon: ${text}${questions ? `\n\n${questions}\n\nResponda no painel do Carbon, no Slack ou no Telegram.` : ""}`);
}

async function dispatch(event: TaskEvent): Promise<void> {
  const task = findTask(event.taskId);
  if (!task) return;
  const settings = getSettings();
  const ticket = task.snapshot;
  const text = eventLine(event, ticket, panelUrl(settings));
  const isQuestion = event.type === "question";
  const jobs: Promise<unknown>[] = [];

  if (isSlackConfigured(settings) && text) {
    jobs.push(notifySlack(settings, task, text, isQuestion ? questionsSlackBlocks(task, ticket, text) : undefined).catch((e) => log("slack", e)));
  }
  if (isTelegramConfigured(settings) && text) {
    jobs.push(notifyTelegram(settings, task, text, ticket, isQuestion).catch((e) => log("telegram", e)));
  }
  if (isJiraConfigured(settings)) {
    jobs.push(notifyJira(settings, task, event, text, ticket).catch((e) => log("jira", e)));
  }
  await Promise.all(jobs);
}

/** Confirms in the originating channel that the task was queued. */
export async function announceQueued(task: Task): Promise<void> {
  const settings = getSettings();
  const text = queuedLine(task.snapshot);
  const jobs: Promise<unknown>[] = [];
  if (task.source === "slack" && isSlackConfigured(settings)) jobs.push(notifySlack(settings, task, text).catch((e) => log("slack", e)));
  if (task.source === "telegram" && isTelegramConfigured(settings)) jobs.push(notifyTelegram(settings, task, text, task.snapshot, false).catch((e) => log("telegram", e)));
  if (task.source === "jira" && isJiraConfigured(settings) && task.sourceRef) {
    jobs.push(commentOnJira(jiraAuth(settings), task.sourceRef, `Carbon: ${text}`).catch((e) => log("jira", e)));
  }
  await Promise.all(jobs);
}

const globalForHub = globalThis as unknown as { carbonIntegrationsStarted?: boolean };

/** Subscribes once to runner lifecycle events. Called from the boot hook. */
export function startIntegrations(): void {
  if (globalForHub.carbonIntegrationsStarted) return;
  globalForHub.carbonIntegrationsStarted = true;
  runnerEvents().on(TASK_EVENT, (event: TaskEvent) => {
    void dispatch(event).catch((e) => log("integrações", e));
  });
}
