import { normalizeQuotes, desanitize, capEditResult, mapDesanIndexToOriginalRange, detectFileRaceOrNull, applyEdit, editImpl, multiEditImpl } from './edit';
import { ReplContext } from '../../context';
import { markRead, canonicalizePath } from './path-utils';

function makeCtx(overrides: Partial<ReplContext> = {}): ReplContext {
  return {
    cwd: '/test',
    autoApprove: false,
    approvedTools: new Set<'Bash'>(),
    activeProject: undefined,
    readCache: new Map<string, { mtime: number; size: number; lineEnding?: 'lf' | 'crlf'; bom?: boolean }>(),
    ...overrides,
  } as any as ReplContext;
}

// ---------------------------------------------------------------------------
// normalizeQuotes
// ---------------------------------------------------------------------------

describe('normalizeQuotes', () => {
  it('replaces left/right single curly quotes with straight', () => {
    expect(normalizeQuotes('\u2018hello\u2019')).toBe("'hello'");
  });
  it('replaces double curly quotes with straight', () => {
    expect(normalizeQuotes('\u201Cworld\u201D')).toBe('"world"');
  });
  it('replaces all varieties', () => {
    expect(normalizeQuotes('\u201A\u201B\u201E\u201F')).toBe("''\"\"");
  });
  it('returns string unchanged when no quotes', () => {
    expect(normalizeQuotes('plain text')).toBe('plain text');
  });
  it('handles empty string', () => {
    expect(normalizeQuotes('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// desanitize
// ---------------------------------------------------------------------------

describe('desanitize', () => {
  it('expands <fnr> to <function_results>', () => {
    expect(desanitize('<fnr>')).toBe('<function_results>');
  });
  it('expands </fnr>', () => {
    expect(desanitize('</fnr>')).toBe('</function_results>');
  });
  it('expands <n> to <name>', () => {
    expect(desanitize('<n>')).toBe('<name>');
  });
  it('expands </n>', () => {
    expect(desanitize('</n>')).toBe('</name>');
  });
  it('expands <o> to <output>', () => {
    expect(desanitize('<o>')).toBe('<output>');
  });
  it('expands <e> to <error>', () => {
    expect(desanitize('<e>')).toBe('<error>');
  });
  it('expands <s> to <system>', () => {
    expect(desanitize('<s>')).toBe('<system>');
  });
  it('expands <r> to <result>', () => {
    expect(desanitize('<r>')).toBe('<result>');
  });
  it('normalizes spacing around meta tags', () => {
    expect(desanitize('< META_START >')).toBe('<META_START>');
  });
  it('handles multiple expansions', () => {
    expect(desanitize('<fnr><n>hello</n></fnr>'))
      .toBe('<function_results><name>hello</name></function_results>');
  });
  it('returns unchanged when no match', () => {
    expect(desanitize('no tags')).toBe('no tags');
  });
  it('handles empty string', () => {
    expect(desanitize('')).toBe('');
  });
  it('expands H: and A: patterns', () => {
    expect(desanitize('\n\nH: hello\n\nA: world'))
      .toBe('\n\nHuman: hello\n\nAssistant: world');
  });
});

// ---------------------------------------------------------------------------
// capEditResult
// ---------------------------------------------------------------------------

describe('capEditResult', () => {
  it('returns string unchanged when within limit', () => {
    const s = 'a'.repeat(500);
    expect(capEditResult(s)).toBe(s);
  });
  it('truncates when over limit', () => {
    const s = 'x'.repeat(110_000);
    const result = capEditResult(s);
    expect(result.length).toBeLessThan(s.length);
    expect(result).toContain('[diff truncated at');
  });
  it('handles empty string', () => {
    expect(capEditResult('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// mapDesanIndexToOriginalRange
// ---------------------------------------------------------------------------

describe('mapDesanIndexToOriginalRange', () => {
  it('maps non-expanded region accurately', () => {
    expect(mapDesanIndexToOriginalRange('hello world', 0, 5))
      .toEqual({ start: 0, end: 5 });
  });

  it('maps expanded <fnr> region', () => {
    // <fnr> = 5 chars original, expands to 19 chars desanitized
    expect(mapDesanIndexToOriginalRange('<fnr>', 0, 19))
      .toEqual({ start: 0, end: 5 });
  });

  it('maps region after expanded tag', () => {
    // "<fnr>hello" — <fnr>=5 chars, expands to <function_results>=18 chars
    // "hello" starts at desanIdx 18
    expect(mapDesanIndexToOriginalRange('<fnr>hello', 18, 5))
      .toEqual({ start: 5, end: 10 });
  });

  it('returns null when target index out of range', () => {
    expect(mapDesanIndexToOriginalRange('', 5, 3)).toBeNull();
  });

  it('handles adjacent expansions', () => {
    // "<e> <s>" — <e>=3 chars, expands to <error>=7 chars
    // First <error> (desan 0-7) maps to <e> (orig 0-3)
    expect(mapDesanIndexToOriginalRange('<e> <s>', 0, 7))
      .toEqual({ start: 0, end: 3 });
  });
});

// ---------------------------------------------------------------------------
// detectFileRaceOrNull
// ---------------------------------------------------------------------------

describe('detectFileRaceOrNull', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null when no cache entry', () => {
    expect(detectFileRaceOrNull(makeCtx(), '/foo')).toBeNull();
  });

  it('returns null when mtime and size match', () => {
    const ctx = makeCtx();
    ctx.readCache.set('/f', { mtime: 100, size: 10 });
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ mtimeMs: 100, size: 10 } as any);
    expect(detectFileRaceOrNull(ctx, '/f')).toBeNull();
  });

  it('returns error when mtime differs', () => {
    const ctx = makeCtx();
    ctx.readCache.set('/f', { mtime: 100, size: 10 });
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ mtimeMs: 200, size: 10 } as any);
    expect(detectFileRaceOrNull(ctx, '/f')).toMatch(/modified since you last read/i);
  });

  it('returns error when size differs', () => {
    const ctx = makeCtx();
    ctx.readCache.set('/f', { mtime: 100, size: 10 });
    jest.spyOn(require('fs'), 'statSync').mockReturnValue({ mtimeMs: 100, size: 20 } as any);
    expect(detectFileRaceOrNull(ctx, '/f')).toMatch(/modified since you last read/i);
  });

  it('returns null when stat throws', () => {
    const ctx = makeCtx();
    ctx.readCache.set('/f', { mtime: 100, size: 10 });
    jest.spyOn(require('fs'), 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(detectFileRaceOrNull(ctx, '/f')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyEdit
// ---------------------------------------------------------------------------

describe('applyEdit', () => {
  it('replaces exact match', () => {
    expect(applyEdit('hello world', 'hello', 'hi', false, 'test')).toBe('hi world');
  });

  it('throws when old_string not found', () => {
    expect(() => applyEdit('hello', 'zzz', 'aa', false, 't')).toThrow(/old_string not found/);
  });

  it('throws when old_string === new_string', () => {
    expect(() => applyEdit('hello', 'hello', 'hello', false, 't')).toThrow(/identical/);
  });

  it('throws on non-unique match without replaceAll', () => {
    expect(() => applyEdit('a a a', 'a', 'b', false, 't')).toThrow(/matches multiple locations/);
  });

  it('replaceAll replaces all occurrences', () => {
    expect(applyEdit('a a a', 'a', 'b', true, 't')).toBe('b b b');
  });

  it('matches curly quotes via normalization (content has curly)', () => {
    expect(applyEdit('\u201Chello\u201D', '"hello"', 'done', false, 't')).toBe('done');
  });

  it('matches curly quotes in old_string against straight in content', () => {
    expect(applyEdit('"hello"', '\u201Chello\u201D', 'done', false, 't')).toBe('done');
  });

  it('matches desanitized tag in content (<fnr> vs <function_results>)', () => {
    expect(applyEdit('x <fnr> y', '<function_results>', 'Z', false, 't')).toBe('x Z y');
  });

  it('matches desanitized tag in old_string (<function_results> vs <fnr>)', () => {
    expect(applyEdit('x <function_results> y', '<fnr>', 'Z', false, 't')).toBe('x Z y');
  });

  it('replaceAll works with desanitized tags (<fnr> opening tag only)', () => {
    // <fnr> matches, </fnr> does NOT desanitize to </function_results> — only opening tags expand
    expect(applyEdit('<fnr> m </fnr>', '<function_results>', 'T', true, 't')).toBe('T m </fnr>');
  });
});

// ---------------------------------------------------------------------------
// editImpl + multiEditImpl integration (temp files)
// ---------------------------------------------------------------------------

describe('editImpl + multiEditImpl integration', () => {
  const mockDir = '/tmp/edit-test-' + Date.now();
  const mockFile = mockDir + '/test.ts';
  const content = 'aaa\nbbb\nccc\n';

  let fsActual: any;

  beforeAll(() => {
    fsActual = jest.requireActual('fs');
    fsActual.mkdirSync(mockDir, { recursive: true });
    fsActual.writeFileSync(mockFile, content, 'utf8');
  });

  afterAll(() => {
    try { fsActual.rmSync(mockDir, { recursive: true, force: true }); } catch { /* */ }
  });

  function setupCtx(): ReplContext {
    const ctx = makeCtx({ cwd: mockDir });
    const canon = canonicalizePath(mockFile);
    const stat = fsActual.statSync(mockFile);
    ctx.readCache.set(canon, { mtime: stat.mtimeMs, size: stat.size, lineEnding: 'lf', bom: false });
    markRead(ctx, canon);
    return ctx;
  }

  beforeEach(() => {
    fsActual.writeFileSync(mockFile, content, 'utf8');
  });

  it('throws when path not absolute', () => {
    expect(() => editImpl({ file_path: 'relative.ts', old_string: 'a', new_string: 'b' }, makeCtx()))
      .toThrow(/Path must be absolute/);
  });

  it('throws when file was not read', () => {
    const ctx = makeCtx();
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    expect(() => editImpl({ file_path: '/some/file.ts', old_string: 'a', new_string: 'b' }, ctx))
      .toThrow(/must Read/);
  });

  it('editImpl replaces content', () => {
    const ctx = setupCtx();
    const result = editImpl({ file_path: mockFile, old_string: 'bbb', new_string: 'BBB' }, ctx);
    expect(result).toMatch(/Edited/);
    expect(fsActual.readFileSync(mockFile, 'utf8')).toBe('aaa\nBBB\nccc\n');
  });

  it('editImpl produces diff', () => {
    const ctx = setupCtx();
    const result = editImpl({ file_path: mockFile, old_string: 'bbb', new_string: 'BBB' }, ctx);
    // Diff format: `- bbb` / `+ BBB` with padding — check content, not prefix format
    expect(result).toContain('bbb');
    expect(result).toContain('BBB');
    expect(result).toMatch(/Edited .+?\./);
  });

  it('multiEditImpl applies multiple edits', () => {
    const ctx = setupCtx();
    const result = multiEditImpl({
      file_path: mockFile,
      edits: [
        { old_string: 'aaa', new_string: 'AAA' },
        { old_string: 'ccc', new_string: 'CCC' },
      ],
    }, ctx);
    expect(result).toMatch(/MultiEdit applied 2 edit/);
    expect(fsActual.readFileSync(mockFile, 'utf8')).toBe('AAA\nbbb\nCCC\n');
  });

  it('multiEditImpl throws when edits empty', () => {
    const ctx = setupCtx();
    expect(() => multiEditImpl({ file_path: mockFile, edits: [] }, ctx))
      .toThrow(/edits array is empty/);
  });

  it('editImpl fails race detection on stale mtime', () => {
    const ctx = makeCtx({ cwd: mockDir });
    const canon = canonicalizePath(mockFile);
    const stat = fsActual.statSync(mockFile);
    ctx.readCache.set(canon, { mtime: stat.mtimeMs - 10000, size: stat.size, lineEnding: 'lf', bom: false });
    markRead(ctx, canon);
    expect(() => editImpl({ file_path: mockFile, old_string: 'bbb', new_string: 'BBB' }, ctx))
      .toThrow(/modified since you last read/);
  });
});
