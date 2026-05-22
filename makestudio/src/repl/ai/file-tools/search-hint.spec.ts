import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globHint, grepHint, readHint } from './search-hint';

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  return dir;
}

describe('search-hint', () => {
  describe('globHint', () => {
    it('returns hint for missing wildcard pattern', () => {
      const tmp = mktmp('searchhint-nowild');
      const hint = globHint('Foo.ts', tmp);
      expect(hint).toContain('no wildcards');
    });

    it('suggests sister extension when looking for .tsx but only .ts present', () => {
      const tmp = mktmp('searchhint-sister');
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'export {};');
      fs.writeFileSync(path.join(tmp, 'b.ts'), 'export {};');
      const hint = globHint('**/*.tsx', tmp);
      expect(hint).toMatch(/did you mean \.ts/);
      expect(hint).toMatch(/2 matches/);
    });

    it('shows top extensions when no sister match available', () => {
      const tmp = mktmp('searchhint-top');
      fs.writeFileSync(path.join(tmp, 'a.rs'), '');
      fs.writeFileSync(path.join(tmp, 'b.rs'), '');
      fs.writeFileSync(path.join(tmp, 'c.toml'), '');
      const hint = globHint('**/*.tsx', tmp);
      expect(hint).toContain('Common extensions');
      expect(hint).toContain('.rs');
    });

    it('flags absolute pattern with leading slash', () => {
      const tmp = mktmp('searchhint-abs');
      const hint = globHint('/etc/passwd', tmp);
      expect(hint).toContain('absolute');
    });

    it('returns empty hint for valid wildcard with sister extension found', () => {
      const tmp = mktmp('searchhint-empty');
      fs.writeFileSync(path.join(tmp, 'x.ts'), '');
      // Looking for the same extension that's present — no useful hint.
      const hint = globHint('**/*.ts', tmp);
      // hint may be empty or only mention "no wildcards" if pattern has none.
      // Pattern has * so we should NOT see that line.
      expect(hint).not.toContain('no wildcards');
    });

    it('skips node_modules / .git when sampling', () => {
      const tmp = mktmp('searchhint-skip');
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'index.js'), '');
      const hint = globHint('**/*.tsx', tmp);
      // node_modules JS files should not appear in the "common extensions"
      // breakdown.
      expect(hint.includes('.js (1)')).toBe(false);
    });
  });

  describe('grepHint', () => {
    it('hints to retry with -i for plain identifier', () => {
      const hint = grepHint('myFunction', '/tmp', { caseInsensitive: false });
      expect(hint).toContain('-i:true');
    });

    it('hints multiline for whitespace pattern', () => {
      const hint = grepHint('import foo from', '/tmp', { multiline: false });
      expect(hint).toContain('multiline:true');
    });

    it('hints for nonexistent search path', () => {
      const hint = grepHint('foo', '/this/path/does/not/exist/xyz', {});
      expect(hint).toContain('does not exist');
    });

    it('does not hint -i when already case-insensitive', () => {
      const hint = grepHint('Foo', '/tmp', { caseInsensitive: true });
      expect(hint).not.toContain('-i:true');
    });

    it('does not hint multiline when already multiline', () => {
      const hint = grepHint('foo bar', '/tmp', { multiline: true });
      expect(hint).not.toContain('multiline:true');
    });
  });

  describe('readHint', () => {
    it('suggests Glob for missing file in existing dir', () => {
      const tmp = mktmp('searchhint-read');
      const hint = readHint(path.join(tmp, 'missing.ts'));
      expect(hint).toContain('Glob');
      expect(hint).toContain('**/missing.ts');
    });

    it('warns about missing parent dir', () => {
      const hint = readHint('/nonexistent-parent-xyz-123/file.ts');
      expect(hint).toContain('parent directory does not exist');
    });
  });
});
