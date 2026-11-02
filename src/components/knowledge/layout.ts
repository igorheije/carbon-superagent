/** Pure helpers for the knowledge graph layout (tested without a canvas). */

const MAX_GROUPS = 10;

/** Directory key: "src/<module>" style for monorepo-ish roots, else the top folder. */
export function groupKey(ref: string): string {
  const parts = ref.split("/");
  if (parts.length <= 1) return ".";
  const roots = ["src", "app", "packages", "apps", "services", "internal", "lib", "modules"];
  if (parts.length > 2 && roots.includes(parts[0] ?? "")) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? ".";
}

/**
 * Assigns each path to one of up to MAX_GROUPS directory clusters (the rest share "outros")
 * and places cluster anchors on an ellipse, biggest clusters first.
 */
export function layoutGroups(refs: readonly string[]): { groupOf: readonly number[]; anchors: readonly (readonly [number, number])[]; names: readonly string[] } {
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(groupKey(r), (counts.get(groupKey(r)) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const kept = ranked.slice(0, MAX_GROUPS - (ranked.length > MAX_GROUPS ? 1 : 0));
  const names = ranked.length > MAX_GROUPS ? [...kept, "outros"] : kept;
  const index = new Map(kept.map((k, i) => [k, i]));
  const groupOf = refs.map((r) => index.get(groupKey(r)) ?? names.length - 1);
  const n = Math.max(1, names.length);
  const anchors = names.map((_, i): readonly [number, number] => {
    if (n === 1) return [0.5, 0.5];
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [0.5 + Math.cos(angle) * 0.33, 0.5 + Math.sin(angle) * 0.32];
  });
  return { groupOf, anchors, names };
}

/** File name, or "folder/file" when the same file name appears more than once. */
export function shortLabel(refs: readonly string[]): readonly string[] {
  const base = refs.map((r) => r.split("/").pop() ?? r);
  const counts = new Map<string, number>();
  for (const b of base) counts.set(b, (counts.get(b) ?? 0) + 1);
  return refs.map((r, i) => {
    const b = base[i] ?? r;
    if ((counts.get(b) ?? 0) < 2) return b;
    const parts = r.split("/");
    return parts.slice(-2).join("/");
  });
}
