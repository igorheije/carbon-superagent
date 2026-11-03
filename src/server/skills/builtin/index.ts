import { AGENT_SKILLS } from "./agent";
import { BACKEND_SKILLS } from "./backend";
import { CORE_SKILLS } from "./core";
import { DELIVERY_SKILLS } from "./delivery";
import { QUALITY_SKILLS } from "./quality";
import { SECURITY_SKILLS } from "./security";
import type { BuiltinSkill } from "./types";

export type { BuiltinSkill } from "./types";

/**
 * Seeded on boot by name (INSERT OR IGNORE): new ones reach existing installs, and an admin's
 * choices on a seeded skill (turned off, personas changed) are never overwritten. Text changes
 * here do not reach installs that already have the skill. Names use the carbon- prefix so they
 * never clash with repo skills.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  ...CORE_SKILLS,
  ...AGENT_SKILLS,
  ...QUALITY_SKILLS,
  ...SECURITY_SKILLS,
  ...BACKEND_SKILLS,
  ...DELIVERY_SKILLS,
];
