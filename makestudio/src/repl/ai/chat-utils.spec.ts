import {
  roughTokens,
  toolFailed,
  stripThoughtLeaves,
  compactMessages,
  truncateAtLineBoundary,
  messagesToTranscript,
  formatCompactSummary,
  extractText,
} from './chat-utils';

describe('roughTokens', () => {
  it('returns 0 for empty string', () => {
    expect(roughTokens('')).toBe(0);
  });
  it('uses ~4 chars per token (rounded up)', () => {
    expect(roughTokens('hello')).toBe(2);          // 5/4 = 1.25 → 2
    expect(roughTokens('a'.repeat(40))).toBe(10);  // 40/4 = 10
    expect(roughTokens('a'.repeat(41))).toBe(11);  // 41/4 = 10.25 → 11
  });
});

describe('toolFailed', () => {
  it('returns false for empty / non-JSON', () => {
    expect(toolFailed('')).toBe(false);
    expect(toolFailed('plain output')).toBe(false);
  });
  it('returns false for valid JSON without an error field', () => {
    expect(toolFailed('{"ok":true}')).toBe(false);
    expect(toolFailed('[1,2,3]')).toBe(false);
  });
  it('returns true for JSON with an error field', () => {
    expect(toolFailed('{"error":"boom"}')).toBe(true);
    expect(toolFailed('{"error":null}')).toBe(false); // falsy
  });
});

describe('stripThoughtLeaves', () => {
  it('removes top-level reasoning_content + thinking_signature', () => {
    const m: any = { role: 'assistant', content: 'hi', reasoning_content: 'thoughts', thinking_signature: 'sig' };
    stripThoughtLeaves(m);
    expect(m.reasoning_content).toBeUndefined();
    expect(m.thinking_signature).toBeUndefined();
  });

  it('filters out type=thinking blocks from content array', () => {
    const m: any = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'mind', signature: 'x' },
        { type: 'text', text: 'visible' },
      ],
    };
    stripThoughtLeaves(m);
    expect(m.content).toBe('visible'); // single text → flattened to string
  });

  it('flattens single text block to plain string', () => {
    const m: any = { role: 'assistant', content: [{ type: 'text', text: 'only' }] };
    stripThoughtLeaves(m);
    expect(m.content).toBe('only');
  });

  it('coerces empty array to null', () => {
    const m: any = { role: 'assistant', content: [{ type: 'thinking' }] };
    stripThoughtLeaves(m);
    expect(m.content).toBeNull();
  });
});

describe('compactMessages', () => {
  it('returns the same array when length ≤ max', () => {
    const arr = [1, 2, 3] as any[];
    expect(compactMessages(arr, 5)).toBe(arr);
  });
  it('keeps the last N when length > max', () => {
    const arr = [1, 2, 3, 4, 5] as any[];
    expect(compactMessages(arr, 3)).toEqual([3, 4, 5]);
  });
});

describe('truncateAtLineBoundary', () => {
  it('returns input unchanged when ≤ target', () => {
    expect(truncateAtLineBoundary('short', 100)).toBe('short');
  });
  it('truncates at a nearby newline within 20% slack', () => {
    const s = 'a'.repeat(80) + '\n' + 'b'.repeat(50) + '\n' + 'c'.repeat(50);
    const out = truncateAtLineBoundary(s, 100);
    expect(out).toMatch(/^a+\n/);
    expect(out).toMatch(/truncated/);
  });
  it('falls back to hard slice when no nearby newline', () => {
    const s = 'a'.repeat(200);
    const out = truncateAtLineBoundary(s, 100);
    // Hard cut at 100 + truncation footer
    expect(out.startsWith('a'.repeat(100))).toBe(true);
    expect(out).toMatch(/truncated/);
  });
});

describe('messagesToTranscript', () => {
  it('formats role + truncated body', () => {
    const out = messagesToTranscript(
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
      1500,
    );
    expect(out).toContain('[user]: hello');
    expect(out).toContain('[assistant]: world');
  });
  it('JSON-stringifies non-string content', () => {
    const out = messagesToTranscript([{ role: 'tool', content: { foo: 1 } }], 1500);
    expect(out).toContain('[tool]: {"foo":1}');
  });
  it('truncates long bodies at maxPerMsg', () => {
    const big = 'x'.repeat(2000);
    const out = messagesToTranscript([{ role: 'user', content: big }], 100);
    expect(out.length).toBeLessThan(150);
  });
});

describe('formatCompactSummary', () => {
  it('strips <analysis>…</analysis>', () => {
    const raw = '<analysis>scratch</analysis>\n<summary>final</summary>';
    expect(formatCompactSummary(raw)).toBe('final');
  });
  it('extracts <summary> body when present', () => {
    expect(formatCompactSummary('prelude\n<summary>body</summary>\nepilogue')).toBe('body');
  });
  it('returns raw text when neither tag present', () => {
    expect(formatCompactSummary('plain summary text')).toBe('plain summary text');
  });
  it('collapses 3+ newlines to 2', () => {
    expect(formatCompactSummary('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('extractText', () => {
  it('returns empty string for empty/missing content', () => {
    expect(extractText({ content: [] })).toBe('');
    expect(extractText({})).toBe('');
    expect(extractText(null)).toBe('');
  });
  it('concatenates type=text blocks', () => {
    const r = { content: [
      { type: 'text', text: 'hello ' },
      { type: 'tool_use', name: 'Read' }, // ignored
      { type: 'text', text: 'world' },
    ] };
    expect(extractText(r)).toBe('hello world');
  });
  it('skips text blocks with empty text', () => {
    const r = { content: [
      { type: 'text', text: '' },
      { type: 'text', text: 'x' },
    ] };
    expect(extractText(r)).toBe('x');
  });
});
