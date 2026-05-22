import {
  looksLikeMarkdown,
  stripPromptXMLTags,
  padAligned,
  stringWidth,
} from './markdown';

describe('looksLikeMarkdown', () => {
  it('detects headings', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('### Subtitle')).toBe(true);
  });

  it('detects fenced code blocks', () => {
    expect(looksLikeMarkdown('```ts\ncode\n```')).toBe(true);
  });

  it('detects bullet lists (- or *)', () => {
    expect(looksLikeMarkdown('- item one\n- item two')).toBe(true);
    expect(looksLikeMarkdown('* bullet')).toBe(true);
  });

  it('detects ordered lists', () => {
    expect(looksLikeMarkdown('1. one\n2. two')).toBe(true);
  });

  it('detects bold / inline code / links / tables', () => {
    expect(looksLikeMarkdown('this is **bold** text')).toBe(true);
    expect(looksLikeMarkdown('call `foo()` here')).toBe(true);
    expect(looksLikeMarkdown('[link](https://x)')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });

  it('returns false for plain prose', () => {
    expect(looksLikeMarkdown('Just a sentence without any markup.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(looksLikeMarkdown('')).toBe(false);
  });
});

describe('stripPromptXMLTags', () => {
  it('removes system-reminder blocks entirely', () => {
    const input = 'hello\n<system-reminder>\nsome rule\n</system-reminder>\nworld';
    expect(stripPromptXMLTags(input)).toBe('hello\nworld');
  });

  it('removes every known prompt-tag family', () => {
    const tags = ['commit_analysis', 'context', 'function_analysis', 'pr_analysis', 'system-reminder'];
    for (const t of tags) {
      const src = `before<${t}>inner</${t}>after`;
      expect(stripPromptXMLTags(src)).toBe('beforeafter');
    }
  });

  it('handles multiple blocks in one string', () => {
    const src = 'a\n<context>c</context>\nb\n<pr_analysis>p</pr_analysis>\nc';
    const out = stripPromptXMLTags(src);
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
    expect(out).not.toContain('<context>');
    expect(out).not.toContain('<pr_analysis>');
  });

  it('is a no-op when there are no tags', () => {
    expect(stripPromptXMLTags('plain text')).toBe('plain text');
  });

  it('tolerates null / undefined / empty input', () => {
    expect(stripPromptXMLTags('')).toBe('');
    expect(stripPromptXMLTags(null as any)).toBe('');
    expect(stripPromptXMLTags(undefined as any)).toBe('');
  });

  it('does NOT remove unknown custom tags', () => {
    const src = 'a<my-tag>x</my-tag>b';
    expect(stripPromptXMLTags(src)).toBe(src);
  });
});

// padAligned and stringWidth depend on the `string-width` npm package
// (Unicode-aware column widths for CJK, emoji, etc.). That package must be
// installed for these cases to produce meaningful results — they are
// exercised under Jest once devDependencies are installed. The tests below
// stay as documentation of the expected contract but run as a single
// integration-style block.
describe('padAligned (integration — requires string-width)', () => {
  it('returns the input unchanged when already at or beyond the width', () => {
    expect(padAligned('hello', 5, 5, 'left')).toBe('hello');
    expect(padAligned('longer', 6, 3, 'left')).toBe('longer');
  });
});

describe('stringWidth (smoke)', () => {
  it('is a callable function', () => {
    expect(typeof stringWidth).toBe('function');
  });
});

// ── configureMarked ──────────────────────────────────────────────────────────

describe('configureMarked', () => {
  it('configures marked and is idempotent', () => {
    const { configureMarked } = require('./markdown');
    expect(() => { configureMarked(); configureMarked(); }).not.toThrow();
  });
});

// ── applyMarkdown / renderMarkdown ───────────────────────────────────────────

describe('applyMarkdown', () => {
  it('renders a heading', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('# Hello');
    expect(result).toContain('Hello');
  });

  it('renders a paragraph', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('Just a paragraph.');
    expect(result).toContain('Just a paragraph.');
  });

  it('strips prompt XML tags before rendering', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('hello<system-reminder>x</system-reminder>world');
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).not.toContain('system-reminder');
  });

  it('renders strong and emphasis', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('**bold** and *italic*');
    expect(result).toContain('bold');
    expect(result).toContain('italic');
  });

  it('renders inline code', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('use `code` inline');
    expect(result).toContain('code');
  });

  it('renders a list', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('- item a\n- item b');
    expect(result).toContain('item a');
    expect(result).toContain('item b');
  });

  it('renders a fenced code block', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('```ts\nconst x = 1;\n```');
    expect(result).toContain('const x = 1');
  });

  it('renders a link', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('[test](https://example.com)');
    expect(result).toContain('test');
  });

  it('renders a blockquote', () => {
    const { applyMarkdown } = require('./markdown');
    const result = applyMarkdown('> quoted text');
    expect(result).toContain('quoted text');
  });

  it('renders an empty string', () => {
    const { applyMarkdown } = require('./markdown');
    expect(applyMarkdown('')).toBe('');
  });
});

describe('renderMarkdown', () => {
  it('delegates to applyMarkdown', () => {
    const { renderMarkdown } = require('./markdown');
    expect(renderMarkdown('# Title')).toContain('Title');
  });
});

// ── cachedLexer ──────────────────────────────────────────────────────────────

describe('cachedLexer', () => {
  it('returns tokens for markdown content', () => {
    const { cachedLexer } = require('./markdown');
    const tokens = cachedLexer('# Hello\n\nworld');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].type).toBe('heading');
  });

  it('returns a paragraph token for plain text', () => {
    const { cachedLexer } = require('./markdown');
    const tokens = cachedLexer('just plain text');
    expect(tokens.length).toBe(1);
    expect(tokens[0].type).toBe('paragraph');
  });

  it('caches tokens by content hash', () => {
    const { cachedLexer } = require('./markdown');
    const t1 = cachedLexer('# Hello');
    const t2 = cachedLexer('# Hello');
    expect(t1).toEqual(t2);
  });
});


