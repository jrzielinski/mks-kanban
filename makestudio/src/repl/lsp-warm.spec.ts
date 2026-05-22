import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectProjectLanguages, warmLspPool, resetLspWarmCache } from './lsp-warm';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

describe('lsp-warm', () => {
  describe('detectProjectLanguages', () => {
    it('detects typescript by package.json', () => {
      const tmp = mktmp('lsp-warm-ts');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      expect(detectProjectLanguages(tmp)).toContain('typescript');
    });

    it('detects typescript by tsconfig.json', () => {
      const tmp = mktmp('lsp-warm-tsconfig');
      fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
      expect(detectProjectLanguages(tmp)).toContain('typescript');
    });

    it('detects python by pyproject.toml', () => {
      const tmp = mktmp('lsp-warm-py');
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '');
      expect(detectProjectLanguages(tmp)).toContain('python');
    });

    it('detects go by go.mod', () => {
      const tmp = mktmp('lsp-warm-go');
      fs.writeFileSync(path.join(tmp, 'go.mod'), 'module foo');
      expect(detectProjectLanguages(tmp)).toContain('go');
    });

    it('detects rust by Cargo.toml', () => {
      const tmp = mktmp('lsp-warm-rust');
      fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '');
      expect(detectProjectLanguages(tmp)).toContain('rust');
    });

    it('detects dart by pubspec.yaml', () => {
      const tmp = mktmp('lsp-warm-dart');
      fs.writeFileSync(path.join(tmp, 'pubspec.yaml'), 'name: test');
      expect(detectProjectLanguages(tmp)).toContain('dart');
    });

    it('detects multiple languages in polyglot repos', () => {
      const tmp = mktmp('lsp-warm-poly');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '');
      fs.writeFileSync(path.join(tmp, 'go.mod'), 'module foo');
      const langs = detectProjectLanguages(tmp);
      expect(langs).toContain('typescript');
      expect(langs).toContain('python');
      expect(langs).toContain('go');
    });

    it('detects csharp via *.csproj glob', () => {
      const tmp = mktmp('lsp-warm-cs');
      fs.writeFileSync(path.join(tmp, 'app.csproj'), '');
      expect(detectProjectLanguages(tmp)).toContain('csharp');
    });

    it('returns empty array for unknown projects', () => {
      const tmp = mktmp('lsp-warm-unknown');
      fs.writeFileSync(path.join(tmp, 'random.txt'), 'nothing');
      expect(detectProjectLanguages(tmp)).toEqual([]);
    });

    it('returns empty array for non-existent path', () => {
      expect(detectProjectLanguages('/nonexistent-xyz-123')).toEqual([]);
    });
  });

  describe('warmLspPool', () => {
    beforeEach(() => {
      delete process.env.MAKESTUDIO_LSP_WARM;
      resetLspWarmCache();
    });

    it('returns empty list when disabled', () => {
      const tmp = mktmp('lsp-warm-disabled');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      expect(warmLspPool(tmp)).toEqual([]);
    });

    it('returns detected languages when enabled', () => {
      process.env.MAKESTUDIO_LSP_WARM = '1';
      resetLspWarmCache();
      const tmp = mktmp('lsp-warm-enabled');
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      const result = warmLspPool(tmp);
      expect(result).toContain('typescript');
    });

    it('returns empty list when no project detected', () => {
      process.env.MAKESTUDIO_LSP_WARM = '1';
      resetLspWarmCache();
      const tmp = mktmp('lsp-warm-empty');
      expect(warmLspPool(tmp)).toEqual([]);
    });
  });
});
