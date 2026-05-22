/**
 * dum-write-validator.ts
 *
 * Lightweight pre-Write validation for DUM JSON files. Mirrors the
 * server-side ISO/IEC/IEEE 29148:2018 quality gate enough to catch the
 * structural problems BEFORE the file lands on disk. The point is to
 * fail fast inside the inner CLI's tool loop — the model gets the
 * error back as the Write result and corrects in the SAME session,
 * instead of (a) writing a bad DUM, (b) save-decomposition pushing it
 * to the backend, (c) the gate flagging it, (d) running a fix-pass
 * subprocess to repair.
 *
 * Trade-off: this duplicates a small subset of the server gate. Kept
 * deliberately minimal — only the BLOCKER-level checks the agent can
 * verify locally without a full ISO 29148 implementation. The full
 * gate still runs server-side after save-decomposition; this is just
 * a first-pass screen.
 */
export interface DumValidationResult {
  ok: boolean;
  errors: string[];
}

export interface DumValidationContext {
  /** When set, the validator confirms the JSON's `tempId` matches. */
  expectedTempId?: string;
  /** When set, the validator confirms the JSON's `type` matches. */
  expectedType?: string;
  /** Section names (without `## `) that MUST appear as headers in the
   *  description. When undefined the section check is skipped. */
  expectedSections?: string[];
}

const PATH_REGEX =
  /(?:\b|\/|^)[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+\.[a-z0-9]{1,5}\b|(?:\b|\/|^)[a-zA-Z0-9._-]+\.(?:ts|tsx|js|jsx|dart|py|sql|md|yaml|yml|json|prisma|env|sh|toml|conf|css|html)\b/g;

// Ported from the server's `complete.ts` — covers TS/JS, Python `def`,
// SQL DDL, Dart/Java/C#/Kotlin C-style, Go `func`, Rust `fn`.
const SIGNATURE_REGEXES: RegExp[] = [
  /\b(?:async\s+)?(?:function\s+)?[A-Za-z_$][\w$]*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[A-Za-z_$<>[\],\s|&{}'"`?]+|->|=>|async)/,
  /\bdef\s+[a-zA-Z_]\w*\s*\(/,
  /\b(?:CREATE\s+(?:TABLE|INDEX|VIEW|TYPE|MATERIALIZED\s+VIEW)|ALTER\s+TABLE)\b/i,
  /\b(?!(?:if|for|while|switch|catch|with|do|else|return|new|throw|delete|typeof|instanceof|in|of|let|const|var|case)\b)[A-Za-z_]\w*(?:<[^>]*>)?\??\s+[A-Za-z_]\w*\s*\([^)]*\)\s*[{;]/,
  /\bfunc\s+[A-Za-z_]\w*\s*\([^)]*\)/,
  /\bfn\s+[A-Za-z_]\w*\s*\([^)]*\)/,
];

/**
 * Universal placeholder tokens — flagged in any context. These are unique
 * enough to never collide with natural prose ("TODO" never appears as a
 * regular word, `???` is always a literal placeholder, etc).
 */
const PLACEHOLDER_REGEXES: Array<{ re: RegExp; label: string }> = [
  { re: /\bTODO\b/, label: 'TODO' },
  { re: /\bFILL_IN\b/, label: 'FILL_IN' },
  { re: /\bXXX\b/, label: 'XXX' },
  { re: /\?{3,}/, label: '???' },
  { re: /<\s*placeholder\s*>/i, label: '<placeholder>' },
];

/**
 * Type-annotation holes — `any` and `unknown` flagged ONLY when they
 * appear in a type context, not as natural-language words. A description
 * like "the system returns any of the following statuses" is fine; what we
 * actually want to catch is `x: any`, `<any>`, `as any` and the same for
 * `unknown`.
 *
 * Earlier the validator used `\b(any|unknown)\b` which produced false
 * positives on prose and rejected legitimate DUMs (José Roberto's report).
 * Tightening to type-context-only matches the spirit of the
 * "no implicit any" gate without bleeding into normal text.
 */
const TYPE_CONTEXT_REGEXES: Array<{ re: RegExp; label: string }> = [
  // "x: any" / ": any " / ": any\n" / ": any|undefined" / ": any[]"
  { re: /:\s*(any|unknown)\b/, label: ': type' },
  // "<any>" / "<any, B>" / "Promise<any>" / "Map<string, any>"
  { re: /<\s*(any|unknown)\s*[,>]/, label: '<type>' },
  // "x as any" / "x as unknown"
  { re: /\bas\s+(any|unknown)\b/, label: 'as type' },
  // ": Promise<any>" / "Array<unknown>" — the comma-separated list above
  // already covers these, kept here for documentation only.
];

/**
 * Find a type-hole in `text`. Returns the literal token + a short
 * human-readable reason, or null when no hole is present.
 */
function findTypeHole(text: string): { match: string; reason: string } | null {
  for (const p of PLACEHOLDER_REGEXES) {
    const m = text.match(p.re);
    if (m) return { match: m[0], reason: `placeholder "${p.label}"` };
  }
  for (const t of TYPE_CONTEXT_REGEXES) {
    const m = text.match(t.re);
    if (m) {
      const tokenIdx = m[1] ? m[0].indexOf(m[1]) : -1;
      const token = m[1] || m[0];
      return { match: token, reason: `type-annotation hole "${token}" (${t.label}) — replace with the concrete type` };
      void tokenIdx;
    }
  }
  return null;
}

/**
 * Validate the JSON content of a DUM file. Returns `{ ok: true }` when
 * the structural minimum is met, otherwise lists the issues. Errors are
 * phrased as fix-hints — the LLM reads them as the Write tool result and
 * adjusts in the same conversation.
 */
export function validateDumJson(
  content: string,
  ctx: DumValidationContext = {},
): DumValidationResult {
  const errors: string[] = [];

  // ── 1. Parse ────────────────────────────────────────────────────
  let dum: any;
  try {
    dum = JSON.parse(content);
  } catch (err: any) {
    return {
      ok: false,
      errors: [`JSON parse failed: ${err.message}. Check escape sequences (\\d, \\s in regex must be \\\\d, \\\\s in JSON strings) and unterminated quotes.`],
    };
  }

  // ── 2. Required top-level fields ────────────────────────────────
  if (typeof dum.tempId !== 'string' || !dum.tempId.trim()) {
    errors.push('Missing required field `tempId` (e.g. `"tempId": "dum_017"`).');
  } else if (ctx.expectedTempId && dum.tempId !== ctx.expectedTempId) {
    errors.push(`Wrong tempId — got "${dum.tempId}", expected "${ctx.expectedTempId}". Use the tempId reserved for this DUM in TEMPIDS.md.`);
  }
  if (typeof dum.title !== 'string' || dum.title.trim().length < 5) {
    errors.push('Missing or too-short `title` (≥5 chars expected).');
  }
  if (typeof dum.type !== 'string' || !dum.type.trim()) {
    errors.push('Missing required field `type` (one of: planning|design|architecture|database|backend|frontend|feature|test|flow|infra|mixed).');
  } else if (ctx.expectedType && dum.type !== ctx.expectedType) {
    errors.push(`Wrong type — got "${dum.type}", expected "${ctx.expectedType}" (this DUM was structured for that type).`);
  }
  if (typeof dum.description !== 'string' || dum.description.trim().length < 200) {
    errors.push('`description` must be a substantive markdown string (≥200 chars). Use the section template for the DUM type.');
  }
  if (!Array.isArray(dum.tasks) || dum.tasks.length === 0) {
    errors.push('`tasks` must be a non-empty array. Each task needs title, description, type, complexity, acceptanceCriteria.');
  }

  // If the basics are wrong there's no point checking deeper — return
  // early so the LLM fixes the structure first.
  if (errors.length > 0) return { ok: false, errors };

  // ── 3. Section headers in description ───────────────────────────
  if (ctx.expectedSections && ctx.expectedSections.length > 0) {
    const missing: string[] = [];
    for (const sec of ctx.expectedSections) {
      // Accept ##/### header with the exact name (allow accent-stripped match).
      const escaped = sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^\\s*#{1,3}\\s+${escaped}\\b`, 'mi');
      if (!re.test(dum.description)) missing.push(sec);
    }
    if (missing.length > 0) {
      errors.push(
        `Missing required section header(s) in description: ${missing.map((s) => `\`## ${s}\``).join(', ')}. ` +
        `Add each as a level-2 markdown header (\`## ${missing[0]}\`).`,
      );
    }
  }

  // ── 4. Concrete file path ───────────────────────────────────────
  PATH_REGEX.lastIndex = 0;
  if (!PATH_REGEX.test(dum.description)) {
    errors.push('Description has no concrete file path with extension. Add at least one (e.g. `src/services/foo.service.ts`, `app/lib/auth/login.dart`, `migrations/001_init.sql`).');
  }

  // ── 5. Method / DDL signature ───────────────────────────────────
  const hasSig = SIGNATURE_REGEXES.some((r) => r.test(dum.description));
  if (!hasSig) {
    errors.push('Description has no method/function/DDL signature. Add at least one (e.g. `createUser(input: CreateUserDto): Promise<User>` or `CREATE TABLE users (id UUID PRIMARY KEY, ...)`).');
  }

  // ── 6. Type holes ───────────────────────────────────────────────
  // `any`/`unknown` are only flagged in type-annotation contexts; pure
  // prose like "any of the following" passes. Placeholders (TODO, ???,
  // XXX, FILL_IN, <placeholder>) flagged anywhere.
  {
    const hole = findTypeHole(dum.description);
    if (hole) {
      errors.push(`Description contains ${hole.reason}. Replace with the actual concrete value/type.`);
    }
  }

  // ── 7. Per-task minimum quality ─────────────────────────────────
  for (let i = 0; i < dum.tasks.length; i++) {
    const t = dum.tasks[i];
    const tRef = `tasks[${i}]${t?.title ? ` (${String(t.title).slice(0, 40)})` : ''}`;
    if (typeof t?.title !== 'string' || t.title.trim().length < 5) {
      errors.push(`${tRef}: missing or too-short title.`);
      continue;
    }
    if (typeof t?.description !== 'string' || t.description.length < 150) {
      errors.push(`${tRef}: \`description\` too short (≥150 chars expected). Use the section template for the task type.`);
    }
    // Server gate (verifiable.ts) accepts ≥1 AC per task at the per-task
    // level; we mirror that to avoid rejecting tasks the server would
    // accept. Set-level checks separately enforce a higher floor for the
    // whole DUM, but that runs server-side.
    if (!Array.isArray(t?.acceptanceCriteria) || t.acceptanceCriteria.length < 1) {
      errors.push(`${tRef}: needs at least 1 acceptanceCriteria entry in DADO/QUANDO/ENTÃO (or GIVEN/WHEN/THEN) format.`);
    } else {
      // Each AC must have at least one concrete value: number / quoted
      // string / path with extension / ALL_CAPS identifier / status code /
      // comparison operator.
      //
      // BDD keywords (DADO/QUANDO/ENTÃO/GIVEN/WHEN/THEN/AND/OR/IF/E/SE)
      // would falsely satisfy the ALL_CAPS rule, so we strip them before
      // running the concrete-value check.
      const BDD_KEYWORDS = /\b(?:DADO|QUANDO|ENTÃO|ENTAO|MAS|GIVEN|WHEN|THEN|AND|OR|IF|E|SE|BUT)\b/g;
      const concreteRe = /\b\d+\b|"[^"]+"|'[^']+'|`[^`]+`|\/[a-zA-Z0-9_/.-]+|\b[A-Z][A-Z0-9_]{3,}\b|[<>]=?|==/;
      for (let k = 0; k < t.acceptanceCriteria.length; k++) {
        const ac = t.acceptanceCriteria[k];
        if (typeof ac !== 'string') {
          errors.push(`${tRef}.acceptanceCriteria[${k}]: must be a string. Got: ${typeof ac}.`);
          continue;
        }
        const stripped = ac.replace(BDD_KEYWORDS, '');
        if (!concreteRe.test(stripped)) {
          errors.push(`${tRef}.acceptanceCriteria[${k}]: needs at least one concrete value (number, quoted string, path, ALL_CAPS enum, status code, or comparison operator). Got: "${ac.slice(0, 80)}".`);
        }
      }
    }
    if (typeof t?.description === 'string') {
      const hole = findTypeHole(t.description);
      if (hole) {
        errors.push(`${tRef}.description contains ${hole.reason}. Replace with the concrete value.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Format a `DumValidationResult` as a readable error string for the LLM.
 * Used as the Write tool's error message when validation fails.
 *
 * Critical UX note: the rejected Write WAS NOT WRITTEN — disk got nothing.
 * Smaller models have a strong tendency to follow up a "write failed" with
 * an Edit on the same path, expecting the partially-written content to be
 * there. It isn't. The next call has to be Write again with the corrected
 * full content. We say this explicitly in the error so the model doesn't
 * waste a turn on a doomed Edit.
 */
export function formatValidationError(result: DumValidationResult, fileName: string): string {
  if (result.ok) return '';
  const head = `Refused to write ${fileName} — DUM failed local quality screen (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}).`;
  const body = result.errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
  const guidance =
    `\n\n⚠️ NOTHING WAS WRITTEN to disk — the file ${fileName} does NOT exist yet. ` +
    `Your next move MUST be another Write call with the FULL corrected JSON. ` +
    `Do NOT use Edit/MultiEdit (there is nothing to edit). ` +
    `Do NOT use Read on this path (it would fail with ENOENT).` +
    `\n\nThe checks above are a subset of the server-side ISO/IEC/IEEE 29148 gate; ` +
    `fixing them locally now avoids the fix-pass round-trip.`;
  return `${head}\n${body}${guidance}`;
}
