import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maybeRewriteDroppedPath, isDndRewriteEnabled, resetDndRewriteCache } from './dnd-path-rewrite';

describe('dnd-path-rewrite', () => {
  let tmpFile: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-rewrite-'));
    tmpFile = path.join(tmpDir, 'dropped.txt');
    fs.writeFileSync(tmpFile, 'hello', 'utf8');
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  beforeEach(() => {
    delete process.env.MAKESTUDIO_DND_AT_REF;
    resetDndRewriteCache();
  });

  describe('maybeRewriteDroppedPath', () => {
    it('rewrites an existing absolute file path', () => {
      const out = maybeRewriteDroppedPath(tmpFile);
      expect(out).toBe('@' + tmpFile);
    });

    it('rewrites an existing absolute directory path', () => {
      const out = maybeRewriteDroppedPath(tmpDir);
      expect(out).toBe('@' + tmpDir);
    });

    it('strips wrapping single quotes (paths with spaces)', () => {
      const spacePath = path.join(tmpDir, 'with space.txt');
      fs.writeFileSync(spacePath, 'x', 'utf8');
      const out = maybeRewriteDroppedPath(`'${spacePath}'`);
      expect(out).toBe('@' + spacePath);
    });

    it('strips wrapping double quotes', () => {
      const out = maybeRewriteDroppedPath(`"${tmpFile}"`);
      expect(out).toBe('@' + tmpFile);
    });

    it('returns null for non-existent paths', () => {
      expect(maybeRewriteDroppedPath('/nonexistent/path/xyz.ts')).toBeNull();
    });

    it('returns null for non-path text (no leading slash)', () => {
      expect(maybeRewriteDroppedPath('just some text')).toBeNull();
      expect(maybeRewriteDroppedPath('regular_word')).toBeNull();
    });

    it('returns null for multi-token input (real prose)', () => {
      expect(maybeRewriteDroppedPath('/foo /bar')).toBeNull();
      expect(maybeRewriteDroppedPath(`Look at ${tmpFile} please`)).toBeNull();
    });

    it('returns null for input that already starts with @', () => {
      expect(maybeRewriteDroppedPath('@' + tmpFile)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(maybeRewriteDroppedPath('')).toBeNull();
    });

    it('returns null for URLs', () => {
      expect(maybeRewriteDroppedPath('https://example.com')).toBeNull();
    });
  });

  describe('isDndRewriteEnabled', () => {
    it('returns false by default', () => {
      expect(isDndRewriteEnabled()).toBe(false);
    });

    it('respects MAKESTUDIO_DND_AT_REF=1', () => {
      process.env.MAKESTUDIO_DND_AT_REF = '1';
      resetDndRewriteCache();
      expect(isDndRewriteEnabled()).toBe(true);
    });

    it('respects MAKESTUDIO_DND_AT_REF=off', () => {
      process.env.MAKESTUDIO_DND_AT_REF = 'off';
      resetDndRewriteCache();
      expect(isDndRewriteEnabled()).toBe(false);
    });
  });
});
