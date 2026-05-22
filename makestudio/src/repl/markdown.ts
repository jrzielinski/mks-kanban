import { swallow } from '../utils/log';
/**
 * markdown.ts
 *
 * Pure token-to-ANSI utilities. Ported from Claude Code:
 *   ~/develop/claude-code/src/utils/markdown.ts
 *
 * React rendering lives in repl/tui/Markdown.tsx — this module is only
 * `formatToken`, `configureMarked`, `padAligned`, `stripPromptXMLTags`,
 * and `applyMarkdown`. Nothing here imports React.
 */

import chalk from 'chalk';
import { marked, Token, Tokens } from 'marked';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripAnsiLib = require('strip-ansi');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stringWidthLib = require('string-width');

function stripAnsi(s: string): string {
  const fn = typeof stripAnsiLib === 'function' ? stripAnsiLib : (stripAnsiLib?.default || ((x: string) => x));
  return fn(s);
}
export function stringWidth(s: string): number {
  const fn = typeof stringWidthLib === 'function' ? stringWidthLib : (stringWidthLib?.default || ((x: string) => x.length));
  return fn(s);
}

// Use \n unconditionally.
const EOL = '\n';

let markedConfigured = false;

export function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;
  // Disable strikethrough parsing — models often use ~ for "approximate"
  // (e.g. ~100) and rarely intend actual strikethrough.
  marked.use({
    tokenizer: {
      del() { return undefined as any; },
    },
  } as any);
}

// Strip custom XML wrappers a model might emit that we don't want to render.
const STRIPPED_TAGS_RE = /<(commit_analysis|context|function_analysis|pr_analysis|system-reminder)>.*?<\/\1>\n?/gs;
export function stripPromptXMLTags(content: string): string {
  return (content || '').replace(STRIPPED_TAGS_RE, '').trim();
}

// ── Theme colours ──────────────────────────────────────────────────────────
// Read from settings on every render so /theme <name> + /restart actually
// takes effect. These are wrapped as getters rather than module-level
// constants because caching would defeat the point.

function currentPalette(): { primary: string; accent: string; success: string; warning: string; danger: string; dim: string; text: string; codeBg: string; codeFg: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./theme').colors();
  } catch {
    return {
      primary: '#22D3EE', accent: '#60A5FA', success: '#22C55E',
      warning: '#FBBF24', danger: '#EF4444', dim: '#64748B',
      text: '#E2E8F0', codeBg: '#1E293B', codeFg: '#E2E8F0',
    };
  }
}

/**
 * Heuristic: does this fenced block contain real code? Used to decide
 * whether cli-highlight should auto-detect a language when no explicit
 * tag was given. Auto-detect on prose / markdown / templates colours
 * random English words as keywords, which looks broken; forcing
 * plaintext for prose avoids that.
 *
 * Triggers: keywords on word boundaries (function/const/let/var/class/
 * import/export/return/def/interface/type/enum), arrow functions, or a
 * brace+semicolon density above ~0.3 chars per line.
 */
function looksLikeCode(text: string): boolean {
  if (!text || text.length < 50) return false;
  if (/\b(function|const|let|var|class|import|export|return|def|interface|type|enum)\s/.test(text)) return true;
  if (/\([^)]*\)\s*=>/.test(text)) return true;
  const lineCount = Math.max(1, text.split('\n').length);
  const codeChars = (text.match(/[{};=]/g) || []).length;
  return codeChars / lineCount > 0.3;
}

const cyan = (s: string): string => chalk.hex(currentPalette().primary)(s);
(cyan as any).bold = (s: string): string => chalk.hex(currentPalette().primary).bold(s);
(cyan as any).underline = (s: string): string => chalk.hex(currentPalette().primary).underline(s);
const blue = (s: string): string => chalk.hex(currentPalette().accent)(s);
(blue as any).bold = (s: string): string => chalk.hex(currentPalette().accent).bold(s);
(blue as any).underline = (s: string): string => chalk.hex(currentPalette().accent).underline(s);
const dim = (s: string): string => chalk.hex(currentPalette().dim)(s);
(dim as any).bold = (s: string): string => chalk.hex(currentPalette().dim).bold(s);
// Codespans: no background — backgrounds bleed to end-of-line when wrap-ansi
// breaks a cell (tables, narrow terminals). We underline + color instead so
// the highlight is visible without triggering the bg-wrap artefact.
const codespanInline = (s: string): string => {
  const p = currentPalette();
  return chalk.hex(p.primary).underline(s);
};

const BLOCKQUOTE_BAR = '│';

/**
 * Pad `content` to `targetWidth` according to alignment. `displayWidth` is
 * the visible width of `content` (callers compute this from stripAnsi'd
 * text so ANSI codes in `content` don't affect padding).
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
  }
  if (align === 'right') return ' '.repeat(padding) + content;
  return content + ' '.repeat(padding);
}

// ── formatToken — the core ANSI emitter ────────────────────────────────────

export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = ((token as any).tokens || [])
        .map((t: Token) => formatToken(t, 0, null, null))
        .join('');
      return inner
        .split(EOL)
        .map((line: string) => stripAnsi(line).trim() ? `${dim(BLOCKQUOTE_BAR)} ${chalk.italic(line)}` : line)
        .join(EOL);
    }
    case 'code': {
      // Diff-style rendering for markdown code blocks: numbered-line gutter
      // + `+` prefix in green (like the Edit-tool diff renderer, see
      // diff-render.ts). Rationale per user feedback: a code block in an
      // assistant response IS conceptually a diff — of an empty file (new
      // code) or of an existing file (update). Giving it the same visual
      // language as real diffs removes the "is this applied or not?"
      // ambiguity and matches the Claude Code diff aesthetic the user
      // prefers.
      //
      // Diverges from Claude Code, which leaves markdown code blocks as
      // plain highlighted text (src/utils/markdown.ts:72-87) — numbered
      // gutter is only used in their fullscreen HighlightedCode component.
      const lang = (token as any).lang ? String((token as any).lang).trim() : '';
      const rawBody = ((token as any).text || '') as string;

      let hl = rawBody;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { highlight } = require('cli-highlight');
        const p = currentPalette();
        // Optional syn* slots let a theme decouple syntax colours from the
        // rest of its UI palette (so `+` markers can stay green while
        // strings use a separate gold). Falls back to the legacy mapping
        // when a theme doesn't define the slot — preserves every existing
        // theme's look unchanged.
        const sk = (p as any).synKeyword || p.accent;
        const sf = (p as any).synFunc    || p.warning;
        const ss = (p as any).synString  || p.success;
        const sn = (p as any).synNumber  || p.warning;
        const st = (p as any).synType    || p.primary;
        const sc = (p as any).synComment || p.dim;
        const theme = {
          keyword:        chalk.hex(sk).bold,
          built_in:       chalk.hex(st),
          type:           chalk.hex(st),
          class:          chalk.hex(st).bold,
          title:          chalk.hex(st),
          'title.class':  chalk.hex(st).bold,
          'title.function': chalk.hex(sf),
          function:       chalk.hex(sf),
          literal:        chalk.hex(sk),
          number:         chalk.hex(sn),
          string:         chalk.hex(ss),
          regexp:         chalk.hex(ss),
          'string.template': chalk.hex(ss),
          'template-variable': chalk.hex(sn),
          comment:        chalk.hex(sc).italic,
          doctag:         chalk.hex(sc).italic,
          params:         chalk.hex(p.text),
          property:       chalk.hex(p.text),
          attr:           chalk.hex(st),
          tag:            chalk.hex(sk),
          'tag.name':     chalk.hex(sk),
          name:           chalk.hex(st),
          symbol:         chalk.hex(sn),
          operator:       chalk.hex(p.text),
          punctuation:    chalk.hex(p.text),
          meta:           chalk.hex(sc),
          'meta.keyword': chalk.hex(sk),
          'variable.language': chalk.hex(sk).italic,
          default:        chalk.hex(p.text),
        };
        // Language resolution for fenced blocks:
        //   1. Explicit tag → use it (most common path).
        //   2. No tag but content LOOKS like code (has typical code
        //      markers — function/const/return on word boundaries, dense
        //      braces/semicolons) → let cli-highlight auto-detect.
        //   3. No tag and content is prose / markdown / a template →
        //      force plaintext. cli-highlight's auto-detect mistakes
        //      prose for code and colours random words like "short",
        //      "paragraph", "user" as keywords, which looks broken.
        const opts: any = { ignoreIllegals: true, theme };
        if (lang) {
          opts.language = lang;
        } else if (looksLikeCode(rawBody)) {
          // omit `language` → cli-highlight auto-detects
        } else {
          opts.language = 'plaintext';
        }
        hl = highlight(rawBody, opts);
      } catch (err) { swallow(err); }

      // Gutter sizing: width of largest line number + 1 space.
      const hlLines = hl.split('\n');
      // Drop trailing empty line produced by a final newline in rawBody.
      if (hlLines.length > 0 && hlLines[hlLines.length - 1] === '') hlLines.pop();
      const totalLines = hlLines.length;
      const gutterDigits = String(totalLines).length;
      const palette = currentPalette();
      const gutterColor = chalk.hex(palette.dim);
      const plusColor = chalk.hex(palette.success);
      // Distinct background for the code block — matches the Claude-Code
      // aesthetic where fenced code visibly stands out from prose. Uses
      // the theme's `codeBg` slot so it adapts to light/dark/dracula etc.
      const codeBg = chalk.bgHex(palette.codeBg);
      // Strip ANSI escapes for visible-width measurement so padding works
      // correctly with syntax-highlighted lines.
      const ansiRe = /\[[0-9;]*m/g;
      const visibleLen = (s: string) => s.replace(ansiRe, '').length;
      // Cell width for the code block — clamp to terminal so the bg fills
      // to the right edge but never wraps. `process.stdout.columns` may be
      // undefined under non-TTY parents; fall back to 100.
      const termCols = (typeof process !== 'undefined' && process.stdout && (process.stdout as any).columns) || 100;
      // Cap so very wide terminals don't end up with a 200-col bg slab.
      const blockCols = Math.max(60, Math.min(termCols - 2, 140));

      // Hard cap on rendered lines. A 600-line config dump rendered
      // line-by-line as cyan slabs hangs the TUI and obliterates context.
      // Past the cap we keep head + tail and elide the middle. Full
      // content remains in ctx.messages / trajectory — only the visual
      // render is truncated.
      const MAX_CODE_LINES = 200;
      const head = Math.floor(MAX_CODE_LINES * 0.7);
      const tail = MAX_CODE_LINES - head;
      const elided = hlLines.length > MAX_CODE_LINES ? hlLines.length - MAX_CODE_LINES : 0;
      const linesToRender = elided > 0
        ? [...hlLines.slice(0, head), ...hlLines.slice(-tail)]
        : hlLines;

      const renderedParts: string[] = [];
      linesToRender.forEach((line, idx) => {
        // Real line number — when truncated, the tail block resumes from
        // (totalLines - tail + offset) so the gutter reflects the
        // original file's lines, not the rendered subset.
        const realIdx = elided > 0 && idx >= head
          ? hlLines.length - (linesToRender.length - idx)
          : idx;
        const num = String(realIdx + 1).padStart(gutterDigits, ' ');
        const prefix = `${gutterColor(num)} ${plusColor('+')}  `;
        const totalVisible = gutterDigits + 1 + 1 + 2 + visibleLen(line);
        const pad = ' '.repeat(Math.max(0, blockCols - totalVisible));
        renderedParts.push(codeBg(`${prefix}${line}${pad}`));
        if (elided > 0 && idx === head - 1) {
          const note = `… ${elided} lines elided (block had ${hlLines.length}; cap ${MAX_CODE_LINES}) …`;
          const notePad = ' '.repeat(Math.max(0, blockCols - note.length - gutterDigits - 4));
          renderedParts.push(codeBg(`${gutterColor(' '.repeat(gutterDigits))} ${gutterColor('·')}  ${gutterColor(note)}${notePad}`));
        }
      });
      return renderedParts.join(EOL) + EOL;
    }
    case 'codespan':
      return codespanInline((token as any).text || '');
    case 'em':
      return chalk.italic(
        ((token as any).tokens || [])
          .map((t: Token) => formatToken(t, 0, null, parent))
          .join(''),
      );
    case 'strong':
      return chalk.bold(
        ((token as any).tokens || [])
          .map((t: Token) => formatToken(t, 0, null, parent))
          .join(''),
      );
    case 'heading': {
      const depth = (token as any).depth as number;
      const inner = ((token as any).tokens || [])
        .map((t: Token) => formatToken(t, 0, null, null))
        .join('');
      switch (depth) {
        case 1: return chalk.bold.underline(cyan(inner)) + EOL + EOL;
        case 2: return chalk.bold(cyan(inner)) + EOL + EOL;
        case 3: return chalk.bold(blue(inner)) + EOL + EOL;
        default: return chalk.bold(dim(inner)) + EOL + EOL;
      }
    }
    case 'hr':
      return dim('───') + EOL + EOL;
    case 'image':
      return (token as any).href || '';
    case 'link': {
      const href: string = (token as any).href || '';
      if (href.startsWith('mailto:')) return href.replace(/^mailto:/, '');
      const linkText = ((token as any).tokens || [])
        .map((t: Token) => formatToken(t, 0, null, token))
        .join('');
      const plain = stripAnsi(linkText);
      if (plain && plain !== href) return chalk.hex(currentPalette().accent).underline(linkText) + dim(` (${href})`);
      return chalk.hex(currentPalette().accent).underline(href);
    }
    case 'list': {
      const items = (token as any).items || [];
      return items
        .map((item: Token, index: number) =>
          formatToken(
            item,
            listDepth,
            (token as any).ordered ? ((token as any).start || 1) + index : null,
            token,
          ),
        )
        .join('');
    }
    case 'list_item': {
      const inner = ((token as any).tokens || [])
        .map((t: Token) =>
          `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token)}`,
        )
        .join('');
      return inner;
    }
    case 'paragraph': {
      const inner = ((token as any).tokens || [])
        .map((t: Token) => formatToken(t, 0, null, null))
        .join('');
      return inner + EOL;
    }
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text': {
      const text: string = (token as any).text || '';
      if (parent?.type === 'link') return text;
      if (parent?.type === 'list_item') {
        const marker = orderedListNumber === null
          ? cyan('•')
          : `${orderedListNumber}.`;
        const subTokens = (token as any).tokens;
        const body = subTokens
          ? subTokens
              .map((t: Token) => formatToken(t, listDepth, orderedListNumber, token))
              .join('')
          : text;
        return `${marker} ${body}${EOL}`;
      }
      return text;
    }
    case 'table': {
      // Tables are handled by the React <MarkdownTable> component.
      // When this function is used as a pure string fallback, emit a
      // best-effort ASCII table.
      return stringifyTable(token as Tokens.Table);
    }
    case 'escape':
      return (token as any).text || '';
    case 'def':
    case 'del':
    case 'html':
      return '';
  }
  return '';
}

function stringifyTable(tableToken: Tokens.Table): string {
  const getDisplay = (tokens: Token[] | undefined): string =>
    stripAnsi((tokens || []).map(t => formatToken(t, 0, null, null)).join(''));
  const widths = tableToken.header.map((h, i) => {
    let w = stringWidth(getDisplay(h.tokens));
    for (const row of tableToken.rows) {
      w = Math.max(w, stringWidth(getDisplay(row[i]?.tokens)));
    }
    return Math.max(w, 3);
  });
  let out = '| ';
  tableToken.header.forEach((h, i) => {
    const content = (h.tokens || []).map(t => formatToken(t, 0, null, null)).join('');
    const disp = getDisplay(h.tokens);
    out += padAligned(content, stringWidth(disp), widths[i], tableToken.align?.[i]) + ' | ';
  });
  out = out.trimEnd() + EOL + '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|' + EOL;
  tableToken.rows.forEach(row => {
    out += '| ';
    row.forEach((cell, i) => {
      const content = (cell.tokens || []).map(t => formatToken(t, 0, null, null)).join('');
      const disp = getDisplay(cell.tokens);
      out += padAligned(content, stringWidth(disp), widths[i], tableToken.align?.[i]) + ' | ';
    });
    out = out.trimEnd() + EOL;
  });
  return out + EOL;
}

/**
 * Render a full markdown string to ANSI text using formatToken.
 * Used by callers that don't have Ink available (plain console.log).
 */
export function applyMarkdown(content: string): string {
  configureMarked();
  return marked
    .lexer(stripPromptXMLTags(content))
    .map(t => formatToken(t, 0, null, null))
    .join('')
    .trim();
}

// Back-compat exports so existing callers keep working while we migrate the
// TUI to <Markdown>. `renderMarkdown` now goes through `applyMarkdown`.
export function renderMarkdown(text: string): string {
  return applyMarkdown(text);
}

export function looksLikeMarkdown(text: string): boolean {
  return /^#{1,6}\s/m.test(text) ||
    /^```/m.test(text) ||
    /^\s*[-*]\s/m.test(text) ||
    /^\s*\d+\.\s/m.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /`[^`]+`/.test(text) ||
    /^\s*\|.*\|/m.test(text) ||
    /\[.+?\]\(.+?\)/.test(text);
}

/** Cached lexer — marked.lexer is ~3ms on long content; cache by content hash. */
const TOKEN_CACHE_MAX = 500;
const tokenCache: Map<string, Token[]> = new Map();

function hashContent(s: string): string {
  // Small, fast hash. Not cryptographic.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return `${s.length}:${h}`;
}

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

export function cachedLexer(content: string): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token.
  if (!hasMarkdownSyntax(content)) {
    return [{
      type: 'paragraph',
      raw: content,
      text: content,
      tokens: [{ type: 'text', raw: content, text: content }] as any,
    } as Token];
  }
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) {
    tokenCache.delete(key);
    tokenCache.set(key, hit);
    return hit;
  }
  configureMarked();
  const tokens = marked.lexer(content);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, tokens);
  return tokens;
}
