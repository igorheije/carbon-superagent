import "server-only";
import type { AgentQuestion, TaskPlacement, Ticket } from "@/lib/domain/types";
import { executionLabel, resolveModel } from "@/lib/domain/models";
import { NO_COMMITS_REF, type ClaimedTask, type CodeSource } from "@/shared/worker-protocol";
import { memoryPromptSection, readRepoMemory, type RepoMemory } from "../knowledge/claude-memory";
import { buildKnowledgeContext } from "../knowledge/context";
import { ensureFreshIndex } from "../knowledge/indexer";
import { listRules } from "../permissions/rules";
import { firstLine, run } from "../proc";
import { findProject, type Project } from "../repo/projects";
import { getSettings } from "../repo/settings";
import { skillsForPersona } from "../repo/skills";
import { promotedLessons, saveSnapshot, type Task } from "../repo/tasks";
import type { Worker } from "../repo/workers";
import { agentcoreSessionId } from "../runtimes/session";
import { appendLog } from "./apply";
import { notifyLive, resetRemoteContext } from "./live";
import { buildPrompt } from "./prompt";
import { answeredQuestions, decisionsSection } from "./questions";
import { releaseLease, type Lease } from "./scheduler";
import { claudeMemoryFiles, projectMapFile, skillFiles, type ContextFile, type SkillRef } from "./workspace";
import { resolveBase, worktreeName } from "./worktree";

/**
 * Turns a claimed remote task into the self-contained ClaimedTask a worker runs: same prompt,
 * skills, knowledge, memory, model and permission rules the local runner would use — but no
 * process is started and no worktree is created here.
 */

export interface PromptParts {
  readonly skills: readonly SkillRef[];
  readonly knowledge: string | null;
  readonly memory: RepoMemory | null;
  readonly decisions: readonly AgentQuestion[];
}

/** The full task prompt. Shared by the local runner and remote claims so both stay identical. */
export function taskPrompt(task: Task, projectId: string, parts: PromptParts): string {
  return buildPrompt({
    key: task.key,
    title: task.title,
    description: task.description,
    persona: task.persona,
    requester: task.snapshot.requester,
    skills: parts.skills,
    lessons: promotedLessons(projectId),
    executor: task.executor,
    knowledge: parts.knowledge,
    claudeMemory: parts.memory ? memoryPromptSection(parts.memory) : null,
    multiAgent: task.snapshot.multiAgent === true,
    decisions: decisionsSection(parts.decisions),
  });
}

/** Branch a task works on, local or remote: "agent/<key>-<id6>". */
export const taskBranch = (task: Pick<Task, "key" | "id">): string => `agent/${worktreeName(task.key, task.id)}`;

const git = (cwd: string, args: readonly string[]) => run("git", args, { cwd, timeoutMs: 30_000 });

/** Credentials embedded in an http(s) remote URL never leave the panel. */
export function stripCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]*@/i, "$1");
}

export function bundleUrlFor(taskId: string): string {
  return `/api/worker/tasks/${encodeURIComponent(taskId)}/bundle`;
}

export interface CodePlan {
  readonly code: CodeSource;
  readonly prBase: string | null;
  readonly notes: readonly string[];
}

/**
 * git transport when the repo has an `origin` remote, has commits and the base branch exists on
 * the remote (as a remote-tracking ref); otherwise the worker downloads a bundle from the panel.
 */
export async function planCode(repoPath: string, baseBranch: string, task: Pick<Task, "key" | "id">): Promise<CodePlan> {
  const branch = taskBranch(task);
  const base = await resolveBase(repoPath, baseBranch);
  const notes = base?.note ? [base.note] : [];
  const bundle = (): CodePlan => ({
    code: { transport: "bundle", baseRef: base?.ref ?? NO_COMMITS_REF, branch, bundleUrl: bundleUrlFor(task.id) },
    prBase: base?.prBase ?? null,
    notes,
  });
  if (!base) return bundle();
  const remote = await git(repoPath, ["remote", "get-url", "origin"]);
  const remoteUrl = remote.ok ? firstLine(remote.stdout) : "";
  if (!remoteUrl) return bundle();
  const onRemote = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base.prBase}^{commit}`]);
  if (!onRemote.ok) return bundle();
  return { code: { transport: "git", remoteUrl: stripCredentials(remoteUrl), baseRef: base.prBase, branch }, prBase: base.prBase, notes };
}

interface Context {
  readonly files: readonly ContextFile[];
  readonly parts: PromptParts;
  readonly hits: Ticket["hits"];
  readonly logs: readonly string[];
}

async function gatherContext(task: Task, project: Project, decisions: readonly AgentQuestion[], useMemory: boolean): Promise<Context> {
  const skills = skillFiles(skillsForPersona(task.persona));
  const logs = [`${skills.refs.length} skills enviadas ao worker`];
  let knowledgePrompt: string | null = null;
  let mapFiles: readonly ContextFile[] = [];
  let hits: Ticket["hits"] = [];
  try {
    await ensureFreshIndex({ id: project.id, repoPath: project.repoPath });
    const knowledge = buildKnowledgeContext(project.id, task.title, task.description);
    if (knowledge) {
      knowledgePrompt = knowledge.prompt;
      mapFiles = [projectMapFile(knowledge.mapMarkdown)];
      hits = knowledge.relevant.map((r, i) => ({ id: `${task.id}-k${i}`, kind: "code" as const, ref: r.path, score: r.score, excerpt: r.summary || "do índice do projeto" }));
      logs.push(`base de conhecimento ok · ${hits.length} arquivos pré-selecionados`);
    } else {
      logs.push("projeto ainda não indexado: o agente vai explorar do zero (mais lento)");
    }
  } catch (error) {
    logs.push(`base de conhecimento indisponível: ${error instanceof Error ? error.message : String(error)}`);
  }
  const memory = useMemory ? readRepoMemory(project.repoPath) : null;
  const files = [...skills.files, ...mapFiles, ...(memory ? claudeMemoryFiles(memory) : [])];
  return { files, hits, logs, parts: { skills: skills.refs, knowledge: knowledgePrompt, memory, decisions } };
}

/** Same reset the local runner applies at the start of a fresh run; a resume keeps everything. */
function startTicket(ticket: Ticket, resuming: boolean): Ticket {
  if (resuming) return { ...ticket, status: "running", resume: false };
  return { ...ticket, status: "running", stage: "intake", logs: [], plan: [], hits: [], diff: [], findings: [], tests: null, pr: null, questions: answeredQuestions(ticket), sessionId: null, resume: false };
}

/** Placement recorded on claim, so the UI does not depend on the claim log line surviving truncation. */
export function placementFor(task: Pick<Task, "id" | "runtime">, worker: Pick<Worker, "id" | "name">): TaskPlacement {
  const isAgentCore = task.runtime === "agentcore";
  return {
    runtime: task.runtime,
    workerId: worker.id,
    workerName: isAgentCore ? null : worker.name,
    agentcoreSessionId: isAgentCore ? agentcoreSessionId(task.id) : null,
  };
}

const formatDecision = (q: AgentQuestion): string => `Question: ${q.text}\nAnswer from ${q.answeredBy ?? "the human"}: ${q.answer ?? ""}`;

/** Marks a claimed task that cannot be prepared as failed and gives the lease back. */
function failClaim(task: Task, workerId: string, reason: string): null {
  const ticket = appendLog({ ...task.snapshot, status: "failed" }, task.snapshot.stage ?? "intake", "warn", reason);
  saveSnapshot(task.id, ticket);
  releaseLease(task.id, workerId);
  notifyLive();
  return null;
}

/**
 * Builds the ClaimedTask for a lease the worker just won and records the hand-off on the ticket.
 * Returns null (task failed, lease released) when the task can no longer run, e.g. its project is gone.
 */
export async function prepareClaim(lease: Lease, worker: Pick<Worker, "id" | "name">, leaseMs: number): Promise<ClaimedTask | null> {
  const { task } = lease;
  const project = task.projectId ? findProject(task.projectId) : null;
  if (!project) return failClaim(task, worker.id, "o projeto desta tarefa não existe mais");
  try {
    const settings = getSettings();
    const resuming = task.snapshot.resume === true;
    const decisions = answeredQuestions(task.snapshot);
    const [plan, context] = await Promise.all([
      planCode(project.repoPath, project.baseBranch, task),
      gatherContext(task, project, decisions, settings.useClaudeMemory),
    ]);
    const choice = resolveModel(task.executor, task.model, task.title, task.description, task.effort);
    const previousCommit = resuming ? (task.snapshot.workspace?.commit ?? null) : null;

    const started = startTicket(task.snapshot, resuming);
    const intake: string[] = [
      `worker ${worker.name} assumiu a tarefa`,
      `${plan.code.transport === "git" ? "clone do remoto" : "bundle do painel"} · branch ${plan.code.branch} ← ${plan.code.baseRef}`,
      ...plan.notes,
      ...context.logs,
      `modelo ${choice.label} — ${choice.reason}`,
    ];
    const stage = started.stage ?? "intake";
    const logged = intake.reduce((t, text) => appendLog(t, stage, "info", text), started);
    const ticket: Ticket = {
      ...logged,
      hits: resuming ? logged.hits : context.hits,
      model: executionLabel(task.executor, choice),
      repo: project.name,
      workspace: { path: "", branch: plan.code.branch, base: plan.code.baseRef, prBase: plan.prBase, commit: previousCommit, isActive: false },
      placement: placementFor(task, worker),
    };
    saveSnapshot(task.id, ticket);
    resetRemoteContext(task.id);
    notifyLive();

    return {
      taskId: task.id,
      key: task.key,
      title: task.title,
      leaseMs,
      executor: task.executor,
      model: choice,
      prompt: taskPrompt(task, project.id, context.parts),
      resume: resuming ? { decisions: decisions.map(formatDecision) } : null,
      code: plan.code,
      limits: { maxRunMinutes: settings.maxRunMinutes },
      permissionRules: listRules(project.repoPath).map((r) => ({ tool: r.tool, pattern: r.pattern })),
      settings: { permissionProfile: settings.permissionProfile, isolateClaudeConfig: settings.isolateClaudeConfig, approvalPolicy: settings.approvalPolicy },
      files: [...context.files],
    };
  } catch (error) {
    return failClaim(task, worker.id, `não foi possível preparar a tarefa para o worker: ${error instanceof Error ? error.message : String(error)}`);
  }
}
