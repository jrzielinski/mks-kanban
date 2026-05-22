import { buildDenialCorrection, buildThrownToolCorrection } from './tool-corrections';

describe('buildDenialCorrection', () => {
  it('handles Bash with the literal command in the message', () => {
    const out = buildDenialCorrection('Bash', { command: 'rm -rf /tmp/x' });
    expect(out).toMatch(/"rm -rf \/tmp\/x"/);
    expect(out).toMatch(/Do NOT retry the same command/);
  });

  it('shell_run is treated like Bash', () => {
    const out = buildDenialCorrection('shell_run', { command: 'docker rm -f foo' });
    expect(out).toMatch(/"docker rm -f foo"/);
  });

  it('Bash truncates to first line + 80 chars', () => {
    const longCmd = 'echo ' + 'x'.repeat(200) + '\nrm -rf /';
    const out = buildDenialCorrection('Bash', { command: longCmd });
    // Original is ~205 chars; the truncated quoted segment must be ≤ 80 + decorations
    const m = out.match(/"([^"]+)"/);
    expect(m).toBeTruthy();
    if (m) expect(m[1].length).toBeLessThanOrEqual(80);
    expect(out).not.toMatch(/rm -rf \//); // newline-stripped
  });

  it('Write/Edit/MultiEdit/NotebookEdit name the path', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const out = buildDenialCorrection(tool, { file_path: '/abs/foo.ts' });
      expect(out).toMatch(/Writing to "\/abs\/foo\.ts" is denied/);
    }
  });

  it('NotebookEdit falls back to notebook_path when file_path missing', () => {
    const out = buildDenialCorrection('NotebookEdit', { notebook_path: '/abs/n.ipynb' });
    expect(out).toMatch(/"\/abs\/n\.ipynb"/);
  });

  it('Write with no path renders (unknown path)', () => {
    const out = buildDenialCorrection('Write', {});
    expect(out).toMatch(/\(unknown path\)/);
  });

  it('WebFetch + web_fetch share branch', () => {
    expect(buildDenialCorrection('WebFetch', {})).toMatch(/non-preapproved domain/);
    expect(buildDenialCorrection('web_fetch', {})).toMatch(/non-preapproved domain/);
  });

  it('unknown tool gets the generic policy hint', () => {
    const out = buildDenialCorrection('SomeRandomTool', {});
    expect(out).toMatch(/Policy denied this call/);
    expect(out).toMatch(/AskUserQuestion/);
  });
});

describe('buildThrownToolCorrection', () => {
  it('returns null for unknown error patterns', () => {
    expect(buildThrownToolCorrection('Read', 'random nonsense')).toBeNull();
  });

  it('matches "must read … before editing"', () => {
    const out = buildThrownToolCorrection('Edit', 'You must Read this file before editing');
    expect(out).toMatch(/Read on the full file first/);
  });

  it('matches FILE_UNCHANGED_STUB hint', () => {
    const out = buildThrownToolCorrection('Read', 'Returned FILE_UNCHANGED stub');
    expect(out).toMatch(/already read this file/);
  });

  it('matches "must be absolute"', () => {
    const out = buildThrownToolCorrection('Read', 'Path must be absolute');
    expect(out).toMatch(/Absolute paths only/);
  });

  it('matches missing file_path variants', () => {
    expect(buildThrownToolCorrection('Read', 'tool requires `file_path`')).toMatch(/expects `file_path`/);
    expect(buildThrownToolCorrection('Read', 'file_path is required, not optional')).toMatch(/expects `file_path`/);
  });

  it('matches mtime / file-changed-between-read-and-edit pattern', () => {
    expect(buildThrownToolCorrection('Edit', 'mtime mismatch')).toMatch(/Re-read and retry/);
    expect(buildThrownToolCorrection('Edit', 'file changed between Read and Edit')).toMatch(/Re-read and retry/);
  });

  it('case-insensitive matching (lowercased internally)', () => {
    const out = buildThrownToolCorrection('Read', 'PATH MUST BE ABSOLUTE');
    expect(out).toMatch(/Absolute paths only/);
  });
});
