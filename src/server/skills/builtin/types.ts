import type { PersonaId } from "@/lib/domain/personas";
import type { SkillInput } from "../parse";

/** A skill seeded on boot. Empty personas = every persona gets it. */
export interface BuiltinSkill extends SkillInput {
  readonly personas: readonly PersonaId[];
}
