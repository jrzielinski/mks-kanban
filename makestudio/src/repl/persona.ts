import { swallow } from '../utils/log';
/**
 * persona.ts — load the agent's IDENTITY / SOUL / USER files into the
 * system prompt.
 *
 * Layout (all user-global so persona stays consistent across projects):
 *
 *   ~/.makestudio/IDENTITY.md   — name, creature, vibe, emoji
 *   ~/.makestudio/SOUL.md       — values + behavioral defaults
 *   ~/.makestudio/USER.md       — profile of the human user
 *
 * Project-local override (rare — for project-specific persona):
 *
 *   <projectRoot>/.makestudio/{IDENTITY,SOUL,USER}.md
 *
 * When both exist the project copy wins. The bootstrap copies the bundled
 * templates from `agent/templates/*.md` to the user-global location on
 * first run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md'] as const;
type PersonaFileName = (typeof PERSONA_FILES)[number];

export interface PersonaSnapshot {
  identity: string | null;
  soul: string | null;
  user: string | null;
}

function readIfExists(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, 'utf8').trim();
    return txt || null;
  } catch { return null; }
}

/**
 * Resolve a persona file across the precedence layers. Project beats user.
 * Returns the FILE PATH, or null if not present anywhere.
 */
function resolvePersonaPath(name: PersonaFileName, projectRoot?: string): string | null {
  const candidates: string[] = [];
  if (projectRoot) candidates.push(path.join(projectRoot, '.makestudio', name));
  candidates.push(path.join(os.homedir(), '.makestudio', name));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Read the three persona files for the active session. Best-effort —
 * missing files return null (the system prompt builder skips that
 * section). Caller passes the project root so a project-local override
 * wins over the user-global default.
 */
export function loadPersona(projectRoot?: string): PersonaSnapshot {
  return {
    identity: readIfExists(resolvePersonaPath('IDENTITY.md', projectRoot) || ''),
    soul:     readIfExists(resolvePersonaPath('SOUL.md',     projectRoot) || ''),
    user:     readIfExists(resolvePersonaPath('USER.md',     projectRoot) || ''),
  };
}

/**
 * Format a persona snapshot as a system-prompt section. Empty when no
 * file resolved — caller can concatenate without checking. Section
 * headers double as anchors so the model can reference them in
 * follow-ups ("the SOUL.md says I shouldn't...").
 */
export function formatPersonaForPrompt(p: PersonaSnapshot): string {
  const parts: string[] = [];
  if (p.identity) {
    parts.push('## IDENTITY (who you are)');
    parts.push(p.identity);
  }
  if (p.soul) {
    parts.push('## SOUL (how you behave)');
    parts.push(p.soul);
  }
  if (p.user) {
    parts.push('## USER (who you are working with)');
    parts.push(p.user);
  }
  return parts.length > 0 ? parts.join('\n\n') : '';
}

/**
 * Locate the bundled `agent/templates/` directory shipped with the agent
 * install — same probing pattern as findAgentSkillsDir / findAgentBundleDir.
 */
function findAgentTemplatesDir(): string | null {
  const candidates: string[] = [];
  try {
    const here = __dirname;
    candidates.push(path.join(here, '..', 'templates'));
    candidates.push(path.join(here, '..', '..', 'templates'));
    candidates.push(path.join(here, 'templates'));
  } catch (err) { swallow(err); }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch (err) { swallow(err); }
  }
  return null;
}

/**
 * Copy IDENTITY/SOUL/USER templates from the agent bundle to the user's
 * `~/.makestudio/` on first run. Idempotent — files that already exist at
 * the destination are skipped.
 *
 * Returns a list of basenames that were created. Used by the boot path
 * to print a one-line "first-time setup" message when the persona files
 * appear for the first time.
 */
export function ensureUserPersonaTemplates(): string[] {
  const created: string[] = [];
  const bundle = findAgentTemplatesDir();
  if (!bundle) return created;
  const dst = path.join(os.homedir(), '.makestudio');
  try { fs.mkdirSync(dst, { recursive: true }); } catch (err) { swallow(err); }
  for (const name of PERSONA_FILES) {
    const src = path.join(bundle, name);
    const tgt = path.join(dst, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(tgt)) continue;
    try {
      fs.copyFileSync(src, tgt);
      created.push(name);
    } catch (err) { swallow(err); }
  }
  return created;
}
