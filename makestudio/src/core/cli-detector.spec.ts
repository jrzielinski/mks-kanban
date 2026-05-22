import { selectCLICommand, getSupportedCLINames } from './cli-detector';

describe('selectCLICommand', () => {
  it('returns the resolved path when the CLI is installed', () => {
    const installed = [
      { name: 'claude', version: '1.0', path: '/usr/local/bin/claude' },
      { name: 'codex', version: '2.0', path: '/opt/bin/codex' },
    ];
    expect(selectCLICommand(installed as any, 'claude')).toBe('/usr/local/bin/claude');
    expect(selectCLICommand(installed as any, 'codex')).toBe('/opt/bin/codex');
  });

  it('falls back to the CLI name when not found in the list', () => {
    expect(selectCLICommand([], 'gemini')).toBe('gemini');
    const other = [{ name: 'claude', version: '1', path: '/x/claude' }];
    expect(selectCLICommand(other as any, 'codex')).toBe('codex');
  });

  it('falls back to the name when the entry has no path', () => {
    const installed = [{ name: 'claude', version: '1.0', path: '' }];
    expect(selectCLICommand(installed as any, 'claude')).toBe('claude');
  });
});

describe('getSupportedCLINames', () => {
  it('returns the canonical three CLIs', () => {
    const names = getSupportedCLINames();
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).toContain('gemini');
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    const a = getSupportedCLINames();
    const b = getSupportedCLINames();
    a.push('hack');
    expect(b).not.toContain('hack');
  });
});
