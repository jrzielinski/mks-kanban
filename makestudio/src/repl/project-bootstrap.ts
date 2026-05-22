import { swallow } from '../utils/log';
/**
 * project-bootstrap.ts — scaffold a project's `.makestudio/` directory.
 *
 * Goal: everything makestudio cares about lives INSIDE the project so it
 * commits with the source and ships to every machine that clones the repo.
 * Nothing important hangs off `~/.makestudio/`.
 *
 * Layout created on bootstrap:
 *
 *   .makestudio/
 *     README.md          — what each subfolder is for
 *     lsp.json           — project-local LSP overrides (empty by default)
 *     skills/            — project-scoped /<skill> commands (.md files)
 *     agents/            — custom dispatch_agent subagent_type definitions
 *     hooks/             — hookify guard rules (.hook.md files)
 *
 * Generated catalogs (`app-builder/`, `flowbuilder/`) are NOT created here
 * — they come from the doc generators under scripts/. The README points at
 * those scripts so users know how to rebuild.
 *
 * Bootstrap is idempotent: re-running on a project that already has files
 * never overwrites them. New entries (e.g. a new subfolder added in a
 * future release) get filled in; existing user content is left alone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Locate a bundled directory inside the agent's install — `skills`,
 * `agents`, or `hooks`. Returns null if not found (e.g. running from a
 * dev tree without the bundles, or an old install). Probes the most
 * likely layouts so dev mode (build/) and published install (dist/)
 * both work.
 */
function findAgentBundleDir(name: 'skills' | 'agents' | 'hooks'): string | null {
  const candidates: string[] = [];
  try {
    const here = __dirname;
    candidates.push(path.join(here, '..', name));
    candidates.push(path.join(here, '..', '..', name));
    candidates.push(path.join(here, name));
  } catch (err) { swallow(err); }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch (err) { swallow(err); }
  }
  return null;
}

/**
 * Copy every .md file from `src` into `dst`, skipping any file that
 * already exists at the destination. Returns the list of relative paths
 * that were created so the caller can report them. Recurses into
 * subdirectories (e.g. `skills/brainstorming/visual-companion.md`).
 */
function copyBundleMd(src: string, dst: string, prefix: string, created: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (!fs.existsSync(dp)) fs.mkdirSync(dp, { recursive: true });
      copyBundleMd(sp, dp, `${prefix}${e.name}/`, created);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.md')) continue;
    if (fs.existsSync(dp)) continue;
    fs.copyFileSync(sp, dp);
    created.push(`${prefix}${e.name}`);
  }
}

const README_BODY = `# .makestudio/

Project-scoped configuration and content for the makestudio agent. Everything
in this directory is **meant to be committed to git** so the same setup
travels with the repository.

## Subfolders

### \`lsp.json\`
Per-project LSP overrides. Merges on top of \`~/.makestudio/lsp.json\` (user
global) which itself merges on top of the agent's builtins. Use this to:

- Add a language server the agent doesn't ship with: \`{"haskell":{"command":["haskell-language-server-wrapper","--lsp"],"extensions":[".hs",".lhs"]}}\`
- Disable a builtin: \`{"pyright":{"disabled":true}}\`
- Override init options: \`{"typescript":{"initialization":{"preferences":{"importModuleSpecifierPreference":"relative"}}}}\`

Schema documented in \`agent/src/repl/lsp.ts\` — \`LspServerConfig\`.

### \`skills/\`
Project-scoped slash commands. Each \`.md\` file with YAML frontmatter
becomes \`/<filename>\` in the REPL. Frontmatter fields: \`name\`,
\`description\`, \`argument-hint\`, \`allowed-tools\`. Body is the prompt the
LLM receives when the user invokes the command.

Project skills override user skills (\`~/.makestudio/skills/\`) which
override agent-bundled skills.

### \`agents/\`
Custom \`dispatch_agent\` subagent definitions. Each \`.md\` file with
frontmatter \`name\`/\`description\`/\`version\` becomes a callable agent type.
Used by skills like \`/feature-dev\` to dispatch specialised reviewers and
architects.

### \`hooks/\`
Preventive guard rules consulted before every tool call. See \`/hookify-help\`
for the full schema. Useful for \`block-rm-rf\`, \`warn-console-log\`, etc.

## Generated content (NOT in this scaffold)

If your project has FlowBuilder nodes or App Builder widgets, run the
catalog generators to produce the reference docs the agent reads:

\`\`\`bash
node scripts/generate-flowbuilder-docs.mjs
node scripts/generate-app-builder-docs.mjs
\`\`\`

Those create \`.makestudio/flowbuilder/\` and \`.makestudio/app-builder/\` with
INDEX.md + per-node/per-widget pages. Re-run after touching the underlying
source.
`;

/**
 * Build the project's initial lsp.json by serialising EVERY entry in
 * BUILTIN_SERVERS. The user opens the file and sees every supported
 * language with its real command/extensions/install hint — they can
 * disable any (`"disabled": true`), override `command` to point at a
 * different binary, or add new languages alongside.
 *
 * Each entry is written verbatim from the registry; nothing is
 * commented-out or hidden. Combined with the registry merge logic
 * (project overrides win), editing this file is the canonical way to
 * shape LSP behavior for a given project.
 */
function buildInitialLspJson(): string {
  // Lazy require so bootstrap doesn't pull the whole LSP module on its
  // own dependency graph if it's never actually called.
  let builtins: Record<string, any> = {};
  try {
    builtins = require('./lsp').BUILTIN_SERVERS || {};
  } catch (err) { swallow(err); }

  const header = {
    _doc: 'Project-local LSP config. Every entry below is a built-in shipped with makestudio — edit `command` to point at a different binary, set `disabled: true` to skip a language, or add a new top-level key for languages not listed. Merges on top of ~/.makestudio/lsp.json (user) and the in-code builtins. Keys starting with `_` are documentation only.',
    _schema: 'name: { command: string[], extensions: string[], env?: Record<string,string>, initialization?: any, disabled?: boolean, fallback?: string[], installHint?: string }',
    _coverage: `${Object.keys(builtins).length} languages bundled out of the box`,
  };

  // Sort builtin keys alphabetically so the file has a stable order
  // (otherwise it depends on object-key insertion order in the JS engine).
  const ordered: Record<string, any> = { ...header };
  for (const name of Object.keys(builtins).sort()) {
    ordered[name] = builtins[name];
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

// Sample skills/agents/hooks were inlined here previously; replaced by the
// "copy every bundled .md from agent/{skills,agents,hooks}" approach below
// so the project gets the FULL bundled set instead of one example each.

interface BootstrapResult {
  created: string[];
  skipped: string[];
  rootDir: string;
}

/**
 * Ensure the project's `.makestudio/` directory exists with the standard
 * layout. Idempotent — files that already exist are left alone, only
 * missing pieces are created. Returns a list of paths created vs skipped
 * for the caller to surface to the user.
 *
 * `rootDir` is typically `ctx.activeProject?.localPath || ctx.cwd`. The
 * caller is responsible for picking the right project root; this function
 * does no walking-up or detection.
 */
export function bootstrapProject(rootDir: string): BootstrapResult {
  const result: BootstrapResult = { created: [], skipped: [], rootDir };
  const root = path.join(rootDir, '.makestudio');

  // 1. Top-level directory.
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    result.created.push('.makestudio/');
  }

  // 2. README.md — only written if missing. Users may have edited it.
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, README_BODY, 'utf8');
    result.created.push('.makestudio/README.md');
  } else {
    result.skipped.push('.makestudio/README.md');
  }

  // 3. lsp.json — full builtin registry serialised so the user can see
  //    every supported language, its real command, and edit any entry.
  const lspJson = path.join(root, 'lsp.json');
  if (!fs.existsSync(lspJson)) {
    fs.writeFileSync(lspJson, buildInitialLspJson(), 'utf8');
    result.created.push('.makestudio/lsp.json');
  } else {
    result.skipped.push('.makestudio/lsp.json');
  }

  // 4. Subdirectories. Each one gets seeded with EVERY bundled .md file
  //    from the agent's install (skills, agents, hooks). The user ends up
  //    with a self-contained project — works on a fresh clone without the
  //    agent shipping any bundle. copyBundleMd skips files that already
  //    exist at the destination, so re-running bootstrap never overwrites
  //    user edits.
  for (const sub of ['skills', 'agents', 'hooks'] as const) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      result.created.push(`.makestudio/${sub}/`);
    }
    const bundle = findAgentBundleDir(sub);
    if (bundle) {
      const before = result.created.length;
      copyBundleMd(bundle, dir, `.makestudio/${sub}/`, result.created);
      // If we didn't seed anything (because everything already existed)
      // AND the dir was just created (it's empty), leave a .gitkeep so
      // git tracks it.
      if (result.created.length === before) {
        const isEmpty = fs.readdirSync(dir).length === 0;
        if (isEmpty) {
          fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf8');
          result.created.push(`.makestudio/${sub}/.gitkeep`);
        }
      }
    } else {
      // No bundle on this install — fall back to .gitkeep so the empty
      // dir survives a git round-trip.
      const isEmpty = fs.readdirSync(dir).length === 0;
      if (isEmpty) {
        fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf8');
        result.created.push(`.makestudio/${sub}/.gitkeep`);
      }
    }
  }

  // 5. Project-specific catalog generators. When the project ships
  //    scripts/generate-{app-builder,flowbuilder}-docs.mjs, run them so
  //    `.makestudio/{app-builder,flowbuilder}/` get populated with the
  //    actual node/widget docs the skills read. The scripts are
  //    project-aware (they hardcode paths into the project's source) so
  //    they only fire when the user has them. Skipped silently otherwise.
  for (const cat of ['app-builder', 'flowbuilder']) {
    const script = path.join(rootDir, 'scripts', `generate-${cat}-docs.mjs`);
    if (!fs.existsSync(script)) continue;
    try {
      const before = countFilesRecursive(path.join(root, cat));
      execSync(`node ${JSON.stringify(script)}`, { cwd: rootDir, stdio: 'pipe' });
      const after = countFilesRecursive(path.join(root, cat));
      const delta = after - before;
      if (delta > 0) {
        result.created.push(`.makestudio/${cat}/  (${delta} files generated)`);
      } else if (after > 0) {
        // Generator ran but every file already existed — still useful
        // signal so the user knows the catalog is current.
        result.skipped.push(`.makestudio/${cat}/  (${after} files, refreshed)`);
      }
    } catch (err: any) {
      // Generator failed — surface the failure but don't break bootstrap.
      result.skipped.push(`.makestudio/${cat}/  (generator failed: ${(err.message || err).toString().split('\n')[0]})`);
    }
  }

  return result;
}

function countFilesRecursive(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFilesRecursive(path.join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

/**
 * Quick check: has this project been scaffolded? Used by auto-bootstrap
 * call sites to decide whether to silently run on first command. Looks for
 * the top-level `.makestudio/` directory only — partial scaffolds count as
 * "yes, the user opted in", and `bootstrapProject()` will fill the gaps.
 */
export function isProjectBootstrapped(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, '.makestudio'));
}
