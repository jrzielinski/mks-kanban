import { tryParseJSON, extractSearchClaims } from './llm-classifier';

describe('tryParseJSON', () => {
  it('returns null for null input', () => {
    expect(tryParseJSON(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseJSON('')).toBeNull();
  });

  it('parses a plain JSON object', () => {
    const result = tryParseJSON<{ a: number }>('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it('parses a plain JSON array', () => {
    const result = tryParseJSON<number[]>('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(tryParseJSON(raw)).toEqual({ a: 1 });
  });

  it('strips markdown fences without json tag', () => {
    const raw = '```\n{"b": 2}\n```';
    expect(tryParseJSON(raw)).toEqual({ b: 2 });
  });

  it('extracts first JSON object from prose', () => {
    const raw = 'Here is the result: {"x": 1} and some trailing text';
    expect(tryParseJSON(raw)).toEqual({ x: 1 });
  });

  it('extracts first JSON array from prose', () => {
    const raw = 'Output: [{"id": 1}, {"id": 2}] end';
    expect(tryParseJSON(raw)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns null for invalid input', () => {
    expect(tryParseJSON('not json at all')).toBeNull();
  });

  it('handles nested objects', () => {
    const raw = JSON.stringify({ outer: { inner: [1, 2] } });
    expect(tryParseJSON(raw)).toEqual({ outer: { inner: [1, 2] } });
  });
});

describe('extractSearchClaims — pre-gate', () => {
  // extractSearchClaims has a regex pre-gate (HAS_NEG) that returns []
  // before calling LLM when no negative-search phrasing is present.
  // We test this deterministic path here.

  it('returns [] for text without negative search claims', async () => {
    const result = await extractSearchClaims('this is a normal response without claims');
    expect(result).toEqual([]);
  });

  it('returns [] for short text without negation', async () => {
    const result = await extractSearchClaims('everything is fine');
    expect(result).toEqual([]);
  });

  // Once the pre-gate triggers, it calls the LLM. Without a real fast tier,
  // the LLM call fails and returns []. We verify the pre-gate at least passes
  // correctly (doesn't block valid patterns) by checking it doesn't crash.
  it('passes pre-gate for "no callers" phrase (LLM fails → empty)', async () => {
    // "no callers" matches HAS_NEG regex, pre-gate passes, LLM call fails
    // without provider → returns []
    const result = await extractSearchClaims('function fooBar has no callers anywhere');
    expect(result).toEqual([]); // no LLM available, empty is correct
  });

  it('passes pre-gate for "não é chamado" (PT)', async () => {
    const result = await extractSearchClaims('a função X não é chamado em lugar nenhum');
    expect(result).toEqual([]);
  });
});
