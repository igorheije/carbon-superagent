import type { MergeResult, Ticket } from "@/lib/domain/types";
import { MAX_SUBTASKS } from "./apply";

/**
 * Prompt sections of a distributed task. Pure: the runner decides which phase applies and passes the
 * merge report in; these functions only write text.
 *
 *   split     — the parent plans, does the shared groundwork and declares CARBON_SUBTASK lines
 *   subtask   — one part, on another machine, limited to its files
 *   integrate — the parent merges what came back, finishes what is missing and runs the tests
 */

export const SPLIT_SECTION = `## Distributed mode (allowed for this task)
Other machines in this Carbon cluster can work on parts of this task at the same time. Decide whether it pays off:
- First plan (CARBON_PLAN) and read the code you need. If the task is small or tightly coupled, ignore this section and do it all yourself.
- Otherwise, do only the shared groundwork here (types, interfaces, contracts, config the parts depend on) so each part can be built on its own.
- Then declare 2-${MAX_SUBTASKS} independent parts, one line each, and stop without implementing them:
  CARBON_SUBTASK: <short title> | <comma-separated files or globs this part may create or change> | <self-contained brief: goal, what already exists, acceptance criteria, how to test>
- Every file belongs to at most one part. A part never needs another part's unfinished work. Keep shared files (lockfiles, central registries, routes index) for yourself.
- Each part runs in a fresh copy of this branch on another machine, without this conversation: the brief must stand on its own.
- After the CARBON_SUBTASK lines, close your plan steps (CARBON_DONE/CARBON_SKIPPED), print a short summary and stop. Carbon commits your groundwork, runs the parts and calls you back to integrate.`;

export interface SubtaskPromptInput {
  readonly parentKey: string;
  readonly parentTitle: string;
  readonly brief: string;
  readonly files: readonly string[];
}

export function subtaskSection(input: SubtaskPromptInput): string {
  return `## You are one part of a distributed task
This is a subtask of ${input.parentKey} (${input.parentTitle}). Other machines are building the other parts in parallel, and the parent agent will merge everything and run the full test suite.
Your assignment:
<subtask-brief>
${input.brief}
</subtask-brief>
Files you may create or change (nothing else): ${input.files.map((f) => `\`${f}\``).join(", ")}
- Stay inside those files. If you need a change elsewhere, do not make it: describe it in your final summary so the parent can do it.
- Do not split this work further and never print CARBON_SUBTASK.
- Test your part as far as it can be tested alone and report exactly what you ran.`;
}

export interface MergeReportEntry {
  readonly key: string;
  readonly title: string;
  readonly result: MergeResult;
  /** Failure reason, or the child's patch when the merge conflicted (already truncated). */
  readonly detail?: string;
}

const RESULT_TEXT: Record<MergeResult, string> = {
  merged: "merged cleanly into this branch",
  empty: "finished without changes",
  conflict: "conflicted with this branch: the merge was aborted; apply its patch below by hand",
  failed: "failed: do this part yourself",
};

export function integrateSection(entries: readonly MergeReportEntry[]): string {
  const lines = entries.map((e) => `- ${e.key} · ${e.title}: ${RESULT_TEXT[e.result]}`).join("\n");
  const details = entries
    .filter((e) => e.detail && (e.result === "conflict" || e.result === "failed"))
    .map((e) => `### ${e.key} (${e.result})\n${e.result === "conflict" ? "```diff\n" + e.detail + "\n```" : e.detail}`)
    .join("\n\n");
  return `## Integration of the distributed parts
You split this task earlier; the parts ran on other machines and are back:
${lines}
${details ? `\n${details}\n` : ""}
Now finish the task in this branch:
- Review what was merged, apply conflicting patches by hand and implement failed parts yourself.
- Make the parts work together (wiring, shared registries, docs), then run the full test suite and fix what breaks.
- Do not print CARBON_SUBTASK again. Plan, test and report with the usual markers.`;
}

/** Which distributed section, if any, this run of the task gets. */
export function distributedPhase(ticket: Ticket): "split" | "subtask" | "integrate" | null {
  if (ticket.parent && ticket.subtask) return "subtask";
  if (ticket.split?.phase === "integrating") return "integrate";
  if (ticket.distributed && !ticket.split) return "split";
  return null;
}
