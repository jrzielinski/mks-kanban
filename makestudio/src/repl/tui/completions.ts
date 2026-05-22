import * as fs from 'fs';
import * as path from 'path';
import { ReplContext } from '../context';

import { swallow } from '../../utils/log';
/**
 * Discovers slash commands by parsing `router.ts` in place — picks up any
 * `case '/foo':` / `case '/bar':` labels. New commands (like `/agent`,
 * `/agents`, `/ostyle`, `/pmode`, etc.) show up in Tab-complete automatically
 * with zero hardcode to maintain.
 *
 * Two source files scanned:
 *   - `repl/router.ts` (main slash handlers)
 *   - `repl/tui/tui-router.ts` (TUI-specific overrides)
 *
 * Scanned once per process start + every 5s (cheap — the files are <100KB
 * and we only slice by regex). Fails open: if the source isn't readable
 * (e.g. bundled as a blob) we fall back to the previous hardcoded list.
 */

const CASE_RX = /case\s+(['"])(\/[\w-]+)\1\s*:/g;
const SCAN_INTERVAL_MS = 5_000;

interface CmdCache { at: number; cmds: string[] }
let cache: CmdCache | null = null;

function scanRouterFiles(): string[] | null {
  // Resolve source paths RELATIVE to this file. When rollup bundles the
  // CLI, dist/index.js is a single file and these sources won't exist —
  // we fall back to the hardcoded list in that case.
  const here = __dirname;
  const candidates = [
    path.resolve(here, '..', 'router.ts'),
    path.resolve(here, 'tui-router.ts'),
    // Bundled path — try the original checkout next to dist/
    path.resolve(here, '..', '..', '..', 'src', 'repl', 'router.ts'),
    path.resolve(here, '..', '..', '..', 'src', 'repl', 'tui', 'tui-router.ts'),
  ];
  const found: Set<string> = new Set();
  let anyReadable = false;
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      anyReadable = true;
      let m: RegExpExecArray | null;
      CASE_RX.lastIndex = 0;
      while ((m = CASE_RX.exec(src)) !== null) found.add(m[2]);
    } catch (err) { swallow(err); }
  }
  if (!anyReadable) return null;
  return Array.from(found).sort();
}

// Safety net: if source parsing fails (production bundle), use this list.
// Kept short and NOT authoritative — the scanner wins when it can read
// the source. Only here so Tab works on unusual installs.
const FALLBACK_COMMANDS = [
  '/help', '/quit', '/clear', '/compact', '/cost', '/ctx', '/status',
  '/model', '/effort', '/sessions', '/resume', '/continue',
  '/permission-mode', '/pmode', '/output-style', '/ostyle',
  '/agent', '/agents', '/stats', '/version', '/coordinator', '/cluster', '/usage',
];

function getBuiltinCommands(): string[] {
  const now = Date.now();
  if (cache && (now - cache.at) < SCAN_INTERVAL_MS) return cache.cmds;
  const scanned = scanRouterFiles();
  const cmds = scanned && scanned.length > 0 ? scanned : FALLBACK_COMMANDS;
  cache = { at: now, cmds };
  return cmds;
}

export interface SlashCompletion {
  name: string;
  description: string;
  source: 'builtin' | 'plugin' | 'skill' | 'agent';
}

/** Same as getCompletions but returns {name, description, source} for the
 *  slash-menu popup. Skills / plugins / agents include their own metadata
 *  so the menu shows useful one-liners for everything, not only built-ins. */
export function getCompletionsWithMeta(input: string, ctx: ReplContext): SlashCompletion[] {
  if (!input.startsWith('/')) return [];
  const lower = input.toLowerCase();
  const cmdPart = lower.split(' ')[0];

  const seen = new Map<string, SlashCompletion>();
  const add = (c: SlashCompletion) => { if (!seen.has(c.name)) seen.set(c.name, c); };

  // Built-in slash commands — pull description from slash-help registry
  let helpRegistry: Record<string, { description?: string }> = {};
  try {
    helpRegistry = require('../slash-help').COMMAND_HELP || {};
  } catch (err) { swallow(err); }
  for (const c of getBuiltinCommands()) {
    if (!c.startsWith(cmdPart)) continue;
    const meta = helpRegistry[c.slice(1)];
    add({ name: c, description: meta?.description || '', source: 'builtin' });
  }

  // Skills — name + description from frontmatter
  try {
    const { loadAllSkills } = require('../skills');
    for (const s of loadAllSkills(ctx.cwd)) {
      const name = '/' + s.name;
      if (!name.startsWith(cmdPart)) continue;
      add({ name, description: s.description || 'Skill', source: 'skill' });
    }
  } catch (err) { swallow(err); }

  // Custom agents
  if (cmdPart === '/agent' && lower.startsWith('/agent ')) {
    try {
      const { loadCustomAgents } = require('../ai/custom-agents');
      const partial = lower.slice('/agent '.length);
      for (const a of loadCustomAgents(ctx.cwd)) {
        if (!a.name.toLowerCase().startsWith(partial)) continue;
        add({ name: '/agent ' + a.name, description: a.description || 'Custom agent', source: 'agent' });
      }
    } catch (err) { swallow(err); }
  }

  // Plugin commands
  try {
    const { pluginRegistry } = require('../../core/plugin-registry');
    for (const c of pluginRegistry.getCommands()) {
      const name = '/' + c.name;
      if (!name.startsWith(cmdPart)) continue;
      add({ name, description: c.description || 'Plugin command', source: 'plugin' });
    }
  } catch (err) { swallow(err); }

  return Array.from(seen.values()).slice(0, 20);
}

export function getCompletions(input: string, ctx: ReplContext): string[] {
  if (!input.startsWith('/')) return [];
  const lower = input.toLowerCase();
  const cmdPart = lower.split(' ')[0];

  const results: string[] = [];

  // Built-in commands — scanned dynamically from router.ts
  for (const c of getBuiltinCommands()) {
    if (c.startsWith(cmdPart)) results.push(c);
  }

  // Skills (already dynamic)
  try {
    const { loadAllSkills } = require('../skills');
    const skills = loadAllSkills(ctx.cwd);
    for (const s of skills) {
      const name = '/' + s.name;
      if (name.startsWith(cmdPart)) results.push(name);
    }
  } catch (err) { swallow(err); }

  // Custom agents — `/<agent-name>` is NOT an alias (you still need
  // `/agent <name>`), but we DO want to complete `/agent <name>` after
  // the user types `/agent `.
  if (cmdPart === '/agent' && lower.startsWith('/agent ')) {
    try {
      const { loadCustomAgents } = require('../ai/custom-agents');
      const partial = lower.slice('/agent '.length);
      for (const a of loadCustomAgents(ctx.cwd)) {
        if (a.name.toLowerCase().startsWith(partial)) results.push('/agent ' + a.name);
      }
    } catch (err) { swallow(err); }
  }

  // Plugin commands
  try {
    const { pluginRegistry } = require('../../core/plugin-registry');
    for (const c of pluginRegistry.getCommands()) {
      const name = '/' + c.name;
      if (name.startsWith(cmdPart)) results.push(name);
    }
  } catch (err) { swallow(err); }

  return Array.from(new Set(results)).slice(0, 12);
}
