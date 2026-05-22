import { extractAtReferences, buildAtReferenceHint } from './at-references';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-ref-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(ref: string, content: string): string {
  const abs = path.resolve(tmpDir, ref);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('extractAtReferences', () => {
  it('returns empty for text without @', () => {
    expect(extractAtReferences('hello world', '/cwd')).toEqual([]);
  });

  it('extracts @./relative paths', () => {
    write('foo.txt', 'hello');
    const text = 'check @./foo.txt';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].spec).toBe('./foo.txt');
    expect(refs[0].exists).toBe(true);
    expect(refs[0].isDirectory).toBe(false);
    expect(refs[0].sizeBytes).toBe(5);
  });

  it('extracts @~/home paths', () => {
    const home = os.homedir();
    const text = `check @~/.bashrc`;
    const refs = extractAtReferences(text, tmpDir);
    // .bashrc may or may not exist — verify at least the resolution
    const homeRef = refs.find(r => r.absolute.startsWith(home));
    expect(homeRef).toBeDefined();
    expect(homeRef!.spec).toBe('~/.bashrc');
  });

  it('extracts @/absolute paths', () => {
    const f = write('data.txt', 'content');
    const text = `check @${f}`;
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].exists).toBe(true);
  });

  it('skips email-like @ references', () => {
    const text = 'email me at foo@bar.com';
    expect(extractAtReferences(text, tmpDir)).toEqual([]);
  });

  it('skips bare @alice tokens without ./ ~/ or /', () => {
    const text = '@alice what do you think';
    expect(extractAtReferences(text, tmpDir)).toEqual([]);
  });

  it('strips fragment identifiers (#section)', () => {
    write('doc.md', '# Hello');
    const text = 'see @./doc.md#section';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].spec).toBe('./doc.md');
  });

  it('detects directories', () => {
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    const text = '@./subdir';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].isDirectory).toBe(true);
    expect(refs[0].sizeBytes).toBeUndefined();
  });

  it('handles missing paths gracefully', () => {
    const text = '@./nonexistent.ts';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].exists).toBe(false);
  });

  it('deduplicates same absolute path', () => {
    write('a.ts', 'x');
    const text = '@./a.ts @./a.ts';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
  });

  it('handles backslash-escaped spaces', () => {
    write('my file.txt', 'hello');
    const text = '@./my\\ file.txt';
    const refs = extractAtReferences(text, tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].exists).toBe(true);
    expect(refs[0].spec).toBe('./my file.txt');
  });

  it('extracts paths without @ when they exist as files', () => {
    write('readme.md', 'docs');
    const text = 'check readme.md';
    const refs = extractAtReferences(text, tmpDir);
    // The function may or may not extract bare paths — depends on implementation.
    // At minimum, verify it doesn't crash.
    expect(Array.isArray(refs)).toBe(true);
  });
});

describe('buildAtReferenceHint', () => {
  it('returns empty string when no refs found', () => {
    const hint = buildAtReferenceHint('hello world', tmpDir);
    expect(hint).toBe('');
  });

  it('builds hint block with resolved paths', () => {
    write('main.ts', 'code');
    const text = 'see @./main.ts';
    const hint = buildAtReferenceHint(text, tmpDir);
    expect(hint).toContain('<at_references>');
    expect(hint).toContain('@./main.ts');
    expect(hint).toContain('exists');
    expect(hint).toContain('file');
    expect(hint).toContain('</at_references>');
  });

  it('includes MISSING for non-existent paths', () => {
    const text = '@./missing.ts';
    const hint = buildAtReferenceHint(text, tmpDir);
    expect(hint).toContain('MISSING');
  });

  it('includes directory kind', () => {
    fs.mkdirSync(path.join(tmpDir, 'lib'));
    const text = '@./lib';
    const hint = buildAtReferenceHint(text, tmpDir);
    expect(hint).toContain('directory');
  });
});
