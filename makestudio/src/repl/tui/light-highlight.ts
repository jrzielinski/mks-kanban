import { swallow } from '../../utils/log';
/**
 * light-highlight.ts — minimal regex-based syntax highlighter.
 *
 * cli-highlight (used by the markdown renderer) is excellent but ~2MB
 * after dependency cost and slow on small inputs because it walks a
 * full grammar. For preview-shaped use cases — diff hunks, multi-line
 * input previews, /replay output — a 200-line regex pass is enough:
 * it catches the eye-grabbing tokens (keywords, strings, numbers,
 * comments) and stays consistent with chalk-based UI.
 *
 * Languages: typescript/javascript, python, bash, json, css. Detection
 * is heuristic and can be overridden via the `lang` argument. Anything
 * unrecognised falls back to no-op (input returned unchanged).
 *
 * Output is tagged with chalk colour codes that respect chalk.level.
 * Test usage can pass `noColor: true` to get the unchanged source so
 * assertions remain readable.
 */

import chalk from 'chalk';

export type Lang = 'ts' | 'js' | 'tsx' | 'py' | 'bash' | 'sh' | 'json' | 'css' | 'plain';

const TS_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch',
  'class', 'const', 'constructor', 'continue', 'debugger', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'never', 'new', 'null', 'number', 'object',
  'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static',
  'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof',
  'undefined', 'unknown', 'var', 'void', 'while', 'with', 'yield',
]);

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'self',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'until',
  'case', 'esac', 'in', 'function', 'return', 'exit', 'export', 'local',
  'readonly', 'declare', 'set', 'unset', 'shift', 'eval', 'source', 'true', 'false',
]);

// Colours — tuned so the highlight is visible but not screaming.
const C = {
  keyword: chalk.hex('#C792EA'),
  string:  chalk.hex('#A5E075'),
  comment: chalk.hex('#5E6679'),
  number:  chalk.hex('#F78C6C'),
  fn:      chalk.hex('#82AAFF'),
  type:    chalk.hex('#FFCB6B'),
  punct:   chalk.hex('#89DDFF'),
};

export function detectLang(source: string): Lang {
  const head = source.slice(0, 800);
  if (/^\s*\{[\s\S]*\}\s*$/m.test(source.trim()) && !/=>|function|const\s|let\s|var\s/.test(head)) {
    try { JSON.parse(source); return 'json'; } catch (err) { swallow(err); }
  }
  if (/^\s*(import|export|const|let|var|function|class|interface|type)\s/.test(head) ||
      /:\s*(string|number|boolean|any|void)\b/.test(head)) {
    return /:\s*\w+\b/.test(head) || /\binterface\s|\btype\s/.test(head) ? 'ts' : 'js';
  }
  if (/^\s*(def|class|import|from)\s/m.test(head) || /:\s*$/m.test(head)) return 'py';
  if (/^\s*#![ \t]*\/(bin|usr)\/(env\s+)?(bash|sh|zsh)\b/.test(head) ||
      /\b(echo|cd|ls|grep|sed|awk|cat|export)\b/.test(head)) return 'bash';
  // CSS — selector ({ class, id, tag, attribute, ::pseudo }) followed
  // by a property:value;. Supports leading "." for class selectors and
  // "#" for id selectors which the previous \w-only pattern missed.
  if (/(?:^|[\s;])[.#]?[\w-]+\s*\{[\s\S]*?:[\s\S]*?\}/.test(head) && /[a-z-]+:\s*[^;]+;/.test(head)) return 'css';
  return 'plain';
}

interface HighlightOpts {
  lang?: Lang;
  /** Disable colour escapes — used by tests so assertions can match raw text. */
  noColor?: boolean;
}

export function lightHighlight(source: string, opts: HighlightOpts = {}): string {
  if (opts.noColor || !source) return source;
  const lang = opts.lang ?? detectLang(source);
  if (lang === 'plain') return source;
  if (lang === 'json') return highlightJson(source);
  if (lang === 'ts' || lang === 'js' || lang === 'tsx') return highlightCLike(source, TS_KEYWORDS);
  if (lang === 'py') return highlightCLike(source, PY_KEYWORDS, '#');
  if (lang === 'bash' || lang === 'sh') return highlightBash(source);
  if (lang === 'css') return highlightCss(source);
  return source;
}

// ── Implementations ──────────────────────────────────────────────

/**
 * Tokenize C-like source (TS/JS/Python) and apply colour. The token
 * order matters: comments and strings must be matched first so we
 * don't colour keywords inside them. We do this by scanning with a
 * single regex that consumes alternatives, then mapping the matched
 * group to a colour.
 */
function highlightCLike(src: string, keywords: Set<string>, lineCommentChar = '//'): string {
  const lineCom = lineCommentChar === '//' ? /\/\/[^\n]*/ : /#[^\n]*/;
  const blockCom = /\/\*[\s\S]*?\*\//;
  const dq = /"(?:\\.|[^"\\])*"/;
  const sq = /'(?:\\.|[^'\\])*'/;
  const tk = /`(?:\\.|[^`\\])*`/;
  const num = /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;
  const ident = /\b[A-Za-z_][A-Za-z0-9_]*\b/;
  const combined = new RegExp(
    [
      blockCom.source,
      lineCom.source,
      dq.source,
      sq.source,
      tk.source,
      num.source,
      ident.source,
    ].join('|'),
    'g',
  );

  return src.replace(combined, (match) => {
    if (match.startsWith('//') || match.startsWith('#') || match.startsWith('/*')) return C.comment(match);
    if (match.startsWith('"') || match.startsWith("'") || match.startsWith('`')) return C.string(match);
    if (/^\d/.test(match)) return C.number(match);
    if (keywords.has(match)) return C.keyword(match);
    if (/^[A-Z]/.test(match) && match.length > 1) return C.type(match);
    return match;
  });
}

function highlightBash(src: string): string {
  const com = /#[^\n]*/;
  const dq = /"(?:\\.|[^"\\])*"/;
  const sq = /'(?:\\.|[^'\\])*'/;
  const flag = /(?:^|[\s])(--?[A-Za-z][A-Za-z0-9-]*)/;
  const num = /\b\d+\b/;
  const ident = /\b[A-Za-z_][A-Za-z0-9_]*\b/;
  const combined = new RegExp(
    [com.source, dq.source, sq.source, flag.source, num.source, ident.source].join('|'),
    'g',
  );

  return src.replace(combined, (match) => {
    if (match.startsWith('#')) return C.comment(match);
    if (match.startsWith('"') || match.startsWith("'")) return C.string(match);
    if (/^\s*-/.test(match)) {
      const flagPart = match.match(/--?[A-Za-z][A-Za-z0-9-]*/)?.[0] || match;
      return match.replace(flagPart, C.fn(flagPart));
    }
    if (/^\d/.test(match)) return C.number(match);
    if (BASH_KEYWORDS.has(match)) return C.keyword(match);
    return match;
  });
}

function highlightJson(src: string): string {
  return src.replace(/("(?:\\.|[^"\\])*")(\s*:)?|(\b\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g,
    (match, str, colon, num, kw) => {
      if (str) {
        // Key vs value — keys are followed by `:`
        return colon ? C.fn(str) + colon : C.string(str);
      }
      if (num) return C.number(num);
      if (kw) return C.keyword(kw);
      return match;
    });
}

function highlightCss(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => C.comment(m))
    .replace(/([a-z-]+)\s*:/g, (_m, p) => C.fn(p) + ':')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => C.string(m))
    .replace(/\b\d+(\.\d+)?(px|em|rem|%|vh|vw|s|ms)?\b/g, (m) => C.number(m));
}
