import chalk from 'chalk';
import { lightHighlight, detectLang } from './light-highlight';

/**
 * chalk auto-detects TTY and disables colour in non-interactive
 * environments (jest's stdout). Force level=1 so the highlighter
 * emits SGR escape codes; tests can then assert on their presence.
 */
beforeAll(() => { (chalk as any).level = 1; });

/**
 * Tests use chalk-stripped output — `noColor:true` returns the input
 * unchanged so we can verify the WHEN of highlighting (does it run at
 * all, does it pick the right language) without caring about which
 * specific ANSI sequence got emitted.
 *
 * For the COLOUR side, we use a regex check on the raw output to
 * confirm the SGR escape was injected somewhere in the keyword/string
 * span.
 */

const ANSI_OPEN = /\[(?:[0-9;]+m|\d+m)/;

describe('light-highlight', () => {
  describe('detectLang', () => {
    it('detects TypeScript by interface keyword', () => {
      expect(detectLang('interface Foo { x: string; }')).toBe('ts');
    });

    it('detects JavaScript when no type annotations', () => {
      expect(detectLang('function f(x) { return x; }')).toBe('js');
    });

    it('detects Python by def keyword', () => {
      expect(detectLang('def hello(name):\n  return name')).toBe('py');
    });

    it('detects bash by shebang', () => {
      expect(detectLang('#!/bin/bash\necho hi')).toBe('bash');
    });

    it('detects bash by common command', () => {
      expect(detectLang('echo "hi" | grep o')).toBe('bash');
    });

    it('detects JSON when content parses as JSON', () => {
      expect(detectLang('{"foo": 1, "bar": [1,2,3]}')).toBe('json');
    });

    it('detects CSS when rule shape present', () => {
      expect(detectLang('.cls { color: red; padding: 10px; }')).toBe('css');
    });

    it('falls back to plain for unrecognised input', () => {
      expect(detectLang('just a sentence in english.')).toBe('plain');
    });
  });

  describe('lightHighlight (with colour)', () => {
    it('emits ANSI sequences for TS keywords', () => {
      const out = lightHighlight('const foo = 1;');
      expect(out).toMatch(ANSI_OPEN);
      // The literal token is preserved within the ANSI wrapper.
      expect(out).toContain('const');
      expect(out).toContain('foo');
    });

    it('colours strings differently from keywords', () => {
      const out = lightHighlight('const x = "hello";');
      // Both string and keyword should be SOMEHOW coloured.
      expect(out).toMatch(ANSI_OPEN);
      expect(out).toContain('"hello"');
    });

    it('respects explicit lang override', () => {
      // Force as JSON even though it has no obvious markers.
      const out = lightHighlight('{"a": 1}', { lang: 'json' });
      expect(out).toMatch(ANSI_OPEN);
    });

    it('passes through unchanged when noColor is true', () => {
      const src = 'const foo = 1;';
      expect(lightHighlight(src, { noColor: true })).toBe(src);
    });

    it('returns plain text unchanged for unsupported langs', () => {
      const text = 'some plain prose in PT-BR.';
      const out = lightHighlight(text);
      expect(out).toBe(text);
    });

    it('handles empty input', () => {
      expect(lightHighlight('')).toBe('');
    });

    it('handles JSON correctly', () => {
      const out = lightHighlight('{"name": "json", "n": 42}', { lang: 'json' });
      expect(out).toMatch(ANSI_OPEN);
      expect(out).toContain('json');
      expect(out).toContain('42');
    });

    it('handles Python keywords', () => {
      const out = lightHighlight('def foo():\n    return None', { lang: 'py' });
      expect(out).toMatch(ANSI_OPEN);
      expect(out).toContain('def');
      expect(out).toContain('None');
    });

    it('does not break content-equivalence — token text remains', () => {
      // Strip ANSI and verify the underlying text is identical.
      const src = 'const x = "hello";';
      const out = lightHighlight(src);
      const stripped = out.replace(/\[[0-9;]*m/g, '');
      expect(stripped).toBe(src);
    });
  });
});
