import { STAGES, type QuestionOption, type ReviewFinding, type StageId } from "@/lib/domain/types";

/**
 * Line protocol the agent prints so the panel can follow its progress.
 * Agent-agnostic: both Claude Code and Codex print the same markers in text.
 */
export type Marker =
  | { readonly kind: "stage"; readonly stage: StageId }
  | { readonly kind: "plan"; readonly text: string }
  | { readonly kind: "done"; readonly stepIndex: number }
  | { readonly kind: "skipped"; readonly stepIndex: number; readonly reason: string }
  | { readonly kind: "tests"; readonly passing: number; readonly total: number }
  | { readonly kind: "finding"; readonly finding: ReviewFinding }
  | { readonly kind: "lesson"; readonly rule: string; readonly evidence: string }
  | { readonly kind: "question"; readonly text: string }
  | { readonly kind: "option"; readonly option: QuestionOption }
  | { readonly kind: "subtask"; readonly title: string; readonly files: readonly string[]; readonly brief: string };

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const MAX_TEXT = 500;
/** Questions carry the options the human must choose from, so they get more room. */
const MAX_QUESTION = 2_000;
// Tolerates markdown the model often adds: list bullets, quotes, bold and inline code.
const MARKER_RE = /^\s*(?:[-*+>]\s+|\d+[.)]\s+)?[`*_]*CARBON_([A-Z]+)[`*_]*:[`*_]*\s*(.*?)[`*_]*\s*$/;

const clip = (text: string, max = MAX_TEXT): string => text.trim().slice(0, max);

/** A subtask brief is the whole assignment of another machine, so it gets more room. */
export const MAX_SUBTASK_BRIEF = 2_000;
const MAX_SUBTASK_FILES = 50;
const MAX_SUBTASK_TITLE = 120;
/** Workspace-relative path or glob: no absolute paths, no "..", no shell-ish characters. */
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.\-/*@+]{1,200}$/;

/** "title | file, file, glob | brief" → subtask marker; null when any part is missing or unsafe. */
function parseSubtask(value: string): Marker | null {
  const [rawTitle = "", rawFiles = "", ...rest] = value.split("|");
  const title = clip(rawTitle.replace(/\s+/g, " "), MAX_SUBTASK_TITLE);
  const files = rawFiles.split(",").map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean);
  const brief = clip(rest.join("|"), MAX_SUBTASK_BRIEF);
  if (!title || !brief || files.length === 0 || files.length > MAX_SUBTASK_FILES) return null;
  if (!files.every((f) => SAFE_PATH.test(f))) return null;
  return { kind: "subtask", title, files: [...new Set(files)], brief };
}

const MAX_OPTION_LABEL = 120;
const RECOMMENDED_RE = /\s*[([]?\s*(recomendad[oa]|recommended)\s*[)\]]?\s*/i;

/** "label | what it implies", with "(recomendado)" anywhere marking the suggested choice. */
function parseOption(value: string): Marker | null {
  const [rawLabel = "", ...rest] = value.split("|");
  const rawDetail = rest.join("|");
  const recommended = RECOMMENDED_RE.test(rawLabel) || RECOMMENDED_RE.test(rawDetail);
  const label = clip(rawLabel.replace(RECOMMENDED_RE, " ").replace(/\s+/g, " "), MAX_OPTION_LABEL);
  const detail = clip(rawDetail.replace(RECOMMENDED_RE, " ").replace(/\s+/g, " "));
  return label ? { kind: "option", option: { label, detail: detail || null, recommended } } : null;
}

function parseLine(line: string): Marker | null {
  const match = MARKER_RE.exec(line);
  if (!match) return null;
  const [, key, rawValue] = match;
  const value = (rawValue ?? "").trim();
  switch (key) {
    case "STAGE": {
      const stage = value.toLowerCase();
      return (STAGES as readonly string[]).includes(stage) ? { kind: "stage", stage: stage as StageId } : null;
    }
    case "PLAN":
      return value ? { kind: "plan", text: clip(value) } : null;
    case "DONE": {
      const n = Number.parseInt(value, 10);
      return Number.isInteger(n) && n >= 1 ? { kind: "done", stepIndex: n - 1 } : null;
    }
    case "SKIPPED": {
      const [num, ...rest] = value.split("|");
      const n = Number.parseInt((num ?? "").trim(), 10);
      return Number.isInteger(n) && n >= 1 ? { kind: "skipped", stepIndex: n - 1, reason: clip(rest.join("|") || "sem motivo informado") } : null;
    }
    case "TESTS": {
      const m = /^(\d+)\s*\/\s*(\d+)/.exec(value);
      if (!m) return null;
      const passing = Number(m[1]);
      const total = Number(m[2]);
      return total > 0 && passing <= total ? { kind: "tests", passing, total } : null;
    }
    case "FINDING": {
      const [sev, ...rest] = value.split("|");
      const severity = (sev ?? "").trim().toUpperCase();
      const text = rest.join("|").trim();
      if (!(SEVERITIES as readonly string[]).includes(severity) || !text) return null;
      const resolved = /\[resolved\]\s*$/i.test(text);
      return {
        kind: "finding",
        finding: { severity: severity as ReviewFinding["severity"], text: clip(text.replace(/\[resolved\]\s*$/i, "")), resolved },
      };
    }
    case "LESSON": {
      const [rule, ...evidence] = value.split("|");
      const ruleText = (rule ?? "").trim();
      return ruleText ? { kind: "lesson", rule: clip(ruleText), evidence: clip(evidence.join("|") || "execução do agente") } : null;
    }
    case "QUESTION":
      return value ? { kind: "question", text: clip(value, MAX_QUESTION) } : null;
    case "OPTION":
      return parseOption(value);
    case "SUBTASK":
      return parseSubtask(value);
    default:
      return null;
  }
}

/** Extracts every protocol marker from a block of agent text, in order. */
export function parseMarkers(text: string): readonly Marker[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const marker = parseLine(line);
    return marker ? [marker] : [];
  });
}

/** Text with marker lines removed, for the human-readable log. */
export function stripMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !MARKER_RE.test(line))
    .join("\n")
    .trim();
}

export const PROTOCOL_INSTRUCTIONS = `
## Progress protocol (required)
Print these markers on their own lines as plain text (no bullets, bold or backticks) as you work. The control panel parses them. Always print the CARBON_PLAN lines before you start coding.
- CARBON_STAGE: <plan|research|code|test|review|reflect>  — when you enter a stage
- CARBON_PLAN: <one verifiable step>                      — one line per plan step (3-7 steps), during plan
- CARBON_DONE: <step number, 1-based>                     — when a plan step is complete
- CARBON_SKIPPED: <step number> | <why>                  — when you deliberately do not do a step
- CARBON_TESTS: <passing>/<total>                         — after each test run
- CARBON_FINDING: <CRITICAL|HIGH|MEDIUM|LOW> | <text>     — self-review findings; append [resolved] once fixed
- CARBON_LESSON: <when X, do Y> | <evidence>              — at the end, 0-2 reusable lessons for this repo
- CARBON_QUESTION: <one decision, self-contained>          — only if a decision blocks you. The human's answer resumes this same session.
- CARBON_OPTION: <short choice> | <what it implies>        — 2-4 lines right after each CARBON_QUESTION; the human clicks one. Add "(recomendado)" to the one you recommend.
  One decision per CARBON_QUESTION (up to 3 in a row if several block you). For names or values (repo, branch, path) offer concrete candidates you found (git remote, gh, package.json), never ask the human to type them. Print the questions last, then stop.

Before your final summary, every plan step must have exactly one CARBON_DONE or CARBON_SKIPPED line. Review the list and close the ones you have not marked yet.
`.trim();
