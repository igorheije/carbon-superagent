import "server-only";
import { randomUUID } from "node:crypto";
import type { PersonaId } from "@/lib/domain/personas";
import type { Lesson, TaskRuntime, Ticket, TicketStatus } from "@/lib/domain/types";
import { getDb, nowIso } from "../db";
import type { ExecutorId } from "./settings";

export type TaskSource = "manual" | "linear" | "github" | "jira" | "slack" | "telegram";

export interface Task {
  readonly id: string;
  readonly projectId: string | null;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly source: TaskSource;
  readonly sourceRef: string | null;
  readonly requesterId: string;
  readonly persona: PersonaId;
  readonly executor: ExecutorId;
  readonly model: string;
  readonly effort: string;
  readonly status: TicketStatus;
  readonly runtime: TaskRuntime;
  readonly position: number;
  readonly snapshot: Ticket;
}

interface TaskRow {
  id: string;
  project_id: string | null;
  key: string;
  title: string;
  description: string;
  source: string;
  source_ref: string | null;
  requester_id: string;
  persona: string;
  executor: string;
  model: string;
  effort: string;
  status: string;
  runtime: string;
  position: number;
  snapshot: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    title: row.title,
    description: row.description,
    source: row.source as TaskSource,
    sourceRef: row.source_ref,
    requesterId: row.requester_id,
    persona: row.persona as PersonaId,
    executor: row.executor as ExecutorId,
    model: row.model,
    effort: row.effort,
    status: row.status as TicketStatus,
    runtime: row.runtime as TaskRuntime,
    position: row.position,
    snapshot: JSON.parse(row.snapshot) as Ticket,
  };
}

export interface NewTask {
  readonly projectId: string;
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly source: TaskSource;
  readonly sourceRef: string | null;
  readonly requesterId: string;
  readonly requesterName: string;
  readonly persona: PersonaId;
  readonly executor: ExecutorId;
  readonly model: string;
  readonly effort: string;
  readonly priority: Ticket["priority"];
  readonly repo: string;
  /** Planned executor · model · effort label (auto already resolved), replaced by the actual one at run start. */
  readonly modelLabel: string;
  /** Where the task runs; defaults to "local" (the panel's own runner). */
  readonly runtime?: TaskRuntime;
}

export function emptyTicket(id: string, task: NewTask, key: string): Ticket {
  return {
    id,
    key,
    title: task.title,
    source: task.source === "manual" ? "github" : task.source,
    repo: task.repo,
    requester: task.requesterName,
    priority: task.priority,
    status: "queued",
    runtime: task.runtime ?? "local",
    stage: null,
    cursor: 0,
    totalEvents: 0,
    plan: [],
    logs: [],
    hits: [],
    diff: [],
    findings: [],
    tests: null,
    pr: null,
    tokens: 0,
    model: task.modelLabel,
    startedAtTick: null,
    endedAtTick: null,
  };
}

export function createTask(task: NewTask): Task {
  const db = getDb();
  const id = randomUUID();
  const maxPos = db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM tasks").get() as { p: number };
  const count = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?").get(task.projectId) as { n: number };
  const key = task.key ?? `FRG-${count.n + 1}`;
  const now = nowIso();
  db.prepare(
    "INSERT INTO tasks (id, project_id, key, title, description, source, source_ref, requester_id, persona, executor, model, effort, priority, status, runtime, position, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
  ).run(id, task.projectId, key, task.title, task.description, task.source, task.sourceRef, task.requesterId, task.persona, task.executor, task.model, task.effort, task.priority, task.runtime ?? "local", maxPos.p + 1, JSON.stringify(emptyTicket(id, task, key)), now, now);
  return findTask(id) as Task;
}

export function findTask(id: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

/** Latest task created from this external item (e.g. a Jira issue), to avoid duplicates. */
export function findTaskBySource(source: TaskSource, sourceRef: string): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE source = ? AND source_ref = ? ORDER BY created_at DESC LIMIT 1").get(source, sourceRef) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function listTasks(projectId: string | null, limit = 50): readonly Task[] {
  const rows = (projectId
    ? getDb().prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY position LIMIT ?").all(projectId, limit)
    : getDb().prepare("SELECT * FROM tasks ORDER BY position LIMIT ?").all(limit)) as unknown as TaskRow[];
  return rows.map(toTask);
}

export function nextQueuedTask(): Task | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY position LIMIT 1").get() as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function saveSnapshot(id: string, snapshot: Ticket): void {
  getDb().prepare("UPDATE tasks SET snapshot = ?, status = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(snapshot), snapshot.status, nowIso(), id);
}

export function moveToFront(id: string): void {
  const db = getDb();
  const min = db.prepare("SELECT COALESCE(MIN(position), 0) AS p FROM tasks").get() as { p: number };
  db.prepare("UPDATE tasks SET position = ? WHERE id = ? AND status = 'queued'").run(min.p - 1, id);
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ? AND status <> 'running'").run(id);
}

/**
 * Local tasks left "running" by a crash/restart go back to failed so nothing hangs forever.
 * Remote tasks (pool/agentcore) keep running on their worker; expired leases are handled by the scheduler.
 */
export function recoverInterruptedTasks(): void {
  const rows = getDb().prepare("SELECT * FROM tasks WHERE runtime = 'local' AND status IN ('running', 'waiting')").all() as unknown as TaskRow[];
  for (const row of rows) {
    const task = toTask(row);
    const hasPendingPermission = (task.snapshot.permissions ?? []).some((p) => p.status === "pending");
    // A "waiting" task that asked a question is legitimately waiting; one blocked on a
    // permission prompt lost its agent process with the restart and can never be answered.
    if (task.status === "waiting" && !hasPendingPermission) continue;
    const permissions = (task.snapshot.permissions ?? []).map((p) => (p.status === "pending" ? { ...p, status: "expired" as const } : p));
    const lastId = task.snapshot.logs.at(-1)?.id ?? 0;
    const logs = [
      ...task.snapshot.logs,
      { id: lastId + 1, stage: task.snapshot.stage ?? "intake", level: "warn" as const, text: "interrompida: o Carbon reiniciou durante a execução — use “rodar de novo”" },
    ];
    saveSnapshot(task.id, { ...task.snapshot, status: "failed", permissions, logs });
  }
}

interface LessonRow {
  id: string;
  task_key: string;
  rule: string;
  evidence: string;
  scope: string;
  confidence: number;
  status: string;
}

/** Lessons of a project, plus legacy ones that predate projects (project_id NULL). */
export function listLessons(projectId: string | null): readonly Lesson[] {
  const rows = (projectId
    ? getDb().prepare("SELECT * FROM lessons WHERE project_id = ? OR project_id IS NULL ORDER BY created_at DESC").all(projectId)
    : getDb().prepare("SELECT * FROM lessons ORDER BY created_at DESC").all()) as unknown as LessonRow[];
  return rows.map((r) => ({
    id: r.id,
    ticketKey: r.task_key,
    rule: r.rule,
    evidence: r.evidence,
    scope: r.scope,
    confidence: r.confidence,
    status: r.status as Lesson["status"],
  }));
}

export function addLesson(projectId: string | null, lesson: Omit<Lesson, "id" | "status">): void {
  getDb()
    .prepare("INSERT INTO lessons (id, project_id, task_key, rule, evidence, scope, confidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?)")
    .run(randomUUID(), projectId, lesson.ticketKey, lesson.rule, lesson.evidence, lesson.scope, lesson.confidence, nowIso());
}

export function setLessonStatus(id: string, status: "promoted" | "discarded"): void {
  getDb().prepare("UPDATE lessons SET status = ? WHERE id = ? AND status = 'candidate'").run(status, id);
}

export function promotedLessons(projectId: string | null): readonly Lesson[] {
  return listLessons(projectId).filter((l) => l.status === "promoted");
}
