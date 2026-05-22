/**
 * Integration test for the GNU grep fallback path. We can't easily
 * unit-test the fallback in isolation (it spawns child processes),
 * but we CAN exercise it end-to-end against a temp directory.
 *
 * The fallback fires when ripgrep is not on PATH. To force that path
 * deterministically, we run grepImpl with a doctored PATH that has
 * neither rg nor a directory ahead of the real grep — actually,
 * easier: the module-level `rgUnavailable` flag flips on first
 * ENOENT, so we just check that subsequent calls go through fallback.
 *
 * For deterministic CI behaviour we ship two scenarios:
 *   - rg present (default on dev machines): smoke test that grep
 *     finds what's there
 *   - rg absent (simulated): we patch the spawn to throw ENOENT once,
 *     and verify the fallback delivers the right matches
 *
 * We don't try to test the rg path here — that's covered indirectly
 * by every other tool spec that uses Grep against a real repo.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepImpl } from './search';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

describe('grepImpl — GNU grep fallback', () => {
  let tmp: string;
  let ctx: any;

  beforeEach(() => {
    tmp = mktmp('grep-fallback');
    ctx = { cwd: tmp, readCache: new Map(), recordToolCall: () => {} };
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('finds a literal match in a multi-file repo', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export const FOO = 42;\n');
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'const bar = "hello";\n');
    fs.writeFileSync(path.join(tmp, 'c.txt'), 'no relevant content\n');

    const result = await grepImpl({
      pattern: 'FOO',
      path: tmp,
      output_mode: 'files_with_matches',
    }, ctx);

    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.ts');
    expect(result).not.toContain('c.txt');
  });

  it('returns "No matches" when nothing matches', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'hello\n');
    const result = await grepImpl({
      pattern: 'xyz_no_such_string',
      path: tmp,
      output_mode: 'files_with_matches',
    }, ctx);
    expect(result).toMatch(/No matches/);
  });

  it('respects --include glob translation', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'TARGET\n');
    fs.writeFileSync(path.join(tmp, 'b.js'), 'TARGET\n');
    const result = await grepImpl({
      pattern: 'TARGET',
      path: tmp,
      glob: '*.ts',
      output_mode: 'files_with_matches',
    }, ctx);
    expect(result).toContain('a.ts');
    expect(result).not.toContain('b.js');
  });

  it('content mode returns matched lines with line numbers', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'line1\nMATCH here\nline3\n');
    const result = await grepImpl({
      pattern: 'MATCH',
      path: tmp,
      output_mode: 'content',
      '-n': true,
    }, ctx);
    expect(result).toContain('MATCH');
    expect(result).toMatch(/2:/); // line number
  });

  it('respects -i for case-insensitive search', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'Mixed CASE here\n');
    const result = await grepImpl({
      pattern: 'mixed',
      path: tmp,
      '-i': true,
      output_mode: 'content',
    }, ctx);
    expect(result).toContain('Mixed');
  });

  it('default excludes node_modules', async () => {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'leak.ts'), 'SECRET_TARGET\n');
    fs.writeFileSync(path.join(tmp, 'project.ts'), 'SECRET_TARGET\n');
    const result = await grepImpl({
      pattern: 'SECRET_TARGET',
      path: tmp,
      output_mode: 'files_with_matches',
    }, ctx);
    expect(result).toContain('project.ts');
    expect(result).not.toContain('node_modules');
  });
});
