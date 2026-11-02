import "server-only";
import { randomUUID } from "node:crypto";
import { isPersonaId, type PersonaId } from "@/lib/domain/personas";
import { getDb, nowIso } from "../db";
import { BUILTIN_SKILLS } from "../skills/builtin";
import type { SkillInput } from "../skills/parse";

export type SkillSource = "builtin" | "created" | "imported";

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly personas: readonly PersonaId[];
  readonly source: SkillSource;
  readonly sourceUrl: string | null;
  readonly enabled: boolean;
  readonly authorId: string | null;
  readonly updatedAt: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  personas: string;
  source: string;
  source_url: string | null;
  enabled: number;
  author_id: string | null;
  updated_at: string;
}

function parsePersonas(raw: string): readonly PersonaId[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((p): p is PersonaId => typeof p === "string" && isPersonaId(p)) : [];
  } catch {
    return [];
  }
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    personas: parsePersonas(row.personas),
    source: row.source as SkillSource,
    sourceUrl: row.source_url,
    enabled: row.enabled === 1,
    authorId: row.author_id,
    updatedAt: row.updated_at,
  };
}

export function seedBuiltinSkills(): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO skills (id, name, description, body, personas, source, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'builtin', 1, ?, ?)",
  );
  for (const skill of BUILTIN_SKILLS) {
    const now = nowIso();
    insert.run(randomUUID(), skill.name, skill.description, skill.body, JSON.stringify(skill.personas), now, now);
  }
}

export function listSkills(): readonly Skill[] {
  seedBuiltinSkills();
  const rows = getDb().prepare("SELECT * FROM skills ORDER BY source = 'builtin' DESC, name").all() as unknown as SkillRow[];
  return rows.map(toSkill);
}

export function findSkill(id: string): Skill | null {
  const row = getDb().prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  return row ? toSkill(row) : null;
}

export function skillNameTaken(name: string, exceptId?: string): boolean {
  const row = getDb().prepare("SELECT id FROM skills WHERE name = ?").get(name) as { id: string } | undefined;
  return Boolean(row && row.id !== exceptId);
}

export interface NewSkill extends SkillInput {
  readonly personas: readonly PersonaId[];
  readonly source: Exclude<SkillSource, "builtin">;
  readonly sourceUrl: string | null;
  readonly enabled: boolean;
  readonly authorId: string;
}

export function createSkill(input: NewSkill): Skill {
  const id = randomUUID();
  const now = nowIso();
  getDb()
    .prepare(
      "INSERT INTO skills (id, name, description, body, personas, source, source_url, enabled, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, input.name, input.description, input.body, JSON.stringify(input.personas), input.source, input.sourceUrl, input.enabled ? 1 : 0, input.authorId, now, now);
  return findSkill(id) as Skill;
}

export function updateSkill(id: string, patch: Partial<SkillInput> & { readonly personas?: readonly PersonaId[]; readonly enabled?: boolean }): Skill | null {
  const current = findSkill(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  getDb()
    .prepare("UPDATE skills SET name = ?, description = ?, body = ?, personas = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.description, next.body, JSON.stringify(next.personas), next.enabled ? 1 : 0, nowIso(), id);
  return findSkill(id);
}

export function deleteSkill(id: string): void {
  getDb().prepare("DELETE FROM skills WHERE id = ? AND source <> 'builtin'").run(id);
}

/** Enabled skills that apply to a persona (empty personas list = everyone). */
export function skillsForPersona(persona: PersonaId): readonly Skill[] {
  return listSkills().filter((s) => s.enabled && (s.personas.length === 0 || s.personas.includes(persona)));
}
