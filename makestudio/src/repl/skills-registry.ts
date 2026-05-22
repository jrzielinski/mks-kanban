/**
 * skills-registry.ts — bundled skill storage, extracted from skills.ts
 * to break the skills ↔ skills-bundled import cycle.
 *
 * The previous shape had skills.ts holding the registry AND lazily
 * `require('./skills-bundled')` to trigger registration, while
 * skills-bundled.ts statically imported `registerBundledSkill` back from
 * skills.ts. Rollup flagged the static cycle.
 *
 * Now both files depend on this neutral module: skills-bundled calls
 * register() at module load, skills reads the populated map. The Skill
 * type is imported with `import type` so the compiler erases the edge.
 */

import type { Skill } from './skills';

const bundledSkills = new Map<string, Skill>();

export function registerBundledSkill(s: Omit<Skill, 'source'>): void {
  const full: Skill = { ...s, source: 'bundled' };
  bundledSkills.set(s.name, full);
}

/** Read-only snapshot of currently-registered bundled skills. */
export function getBundledSkillsMap(): ReadonlyMap<string, Skill> {
  return bundledSkills;
}

/** Clear the registry — used by tests + `/reload-skills` slash command. */
export function __clearBundledSkillsForTests(): void {
  bundledSkills.clear();
}
