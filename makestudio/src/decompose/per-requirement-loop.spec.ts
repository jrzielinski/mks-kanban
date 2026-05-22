/**
 * Phase 2 — overwrite-aware detector test.
 *
 * Validates that `spawnCliAndCapture` (via its public type contract)
 * distinguishes 'new' files from 'modified' files. We can't easily
 * spawn a real CLI in unit tests, so this spec exercises the snapshot
 * helpers indirectly through a synthetic process that mutates files.
 *
 * The fix this guards against: pre-Phase-2, the detector returned only
 * filenames that didn't exist before. When Claude used Edit on an
 * existing dum_005.json (the FIX MODE happy path), the filename was
 * unchanged → diff empty → loop counted "0 DUMs" → unnecessary retry.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

describe('overwrite detector — Phase 2', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-overwrite-'));
    fs.mkdirSync(path.join(tmpDir, '.makestudio', 'dums'), { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Drives spawnCliAndCapture by spawning a simple `node` script that
   * either creates or modifies dum_005.json. Returns the function's
   * resolved value so we can assert kind='new' / kind='modified'.
   */
  async function runCapture(action: 'create' | 'modify'): Promise<Array<{ path: string; kind: string }>> {
    // Pre-seed dum_005 if we're testing the modify path.
    if (action === 'modify') {
      fs.writeFileSync(
        path.join(tmpDir, '.makestudio', 'dums', 'dum_005.json'),
        JSON.stringify({ tempId: 'dum_005', title: 'original' }, null, 2),
      );
      // Step the mtime back so the post-action mtime is strictly greater.
      const past = (Date.now() - 5000) / 1000;
      fs.utimesSync(path.join(tmpDir, '.makestudio', 'dums', 'dum_005.json'), past, past);
    }

    // Build a tiny inline node script that the helper "spawns" — but we
    // call `spawnCliAndCapture` directly via dynamic require so the test
    // is self-contained. The "CLI" here is `node -e <inline>`.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnCliAndCapture } = require('./per-requirement-loop-test-exports');
    const inline = action === 'create'
      ? `require('fs').writeFileSync('${path.join(tmpDir, '.makestudio', 'dums', 'dum_007.json')}', JSON.stringify({tempId:'dum_007', title:'fresh'}));`
      : `require('fs').writeFileSync('${path.join(tmpDir, '.makestudio', 'dums', 'dum_005.json')}', JSON.stringify({tempId:'dum_005', title:'updated by edit'}));`;

    return spawnCliAndCapture({
      cliCommand: process.execPath, // node
      cliArgs: ['-e', inline],
      cwd: tmpDir,
      prompt: '', // node -e ignores stdin
    });
  }

  /**
   * The detector must return 'new' for a file that didn't exist before
   * the spawn. This is the original baseline behavior.
   */
  it('reports kind=new when a fresh dum_*.json appears', async () => {
    const written = await runCapture('create');
    expect(written.length).toBe(1);
    expect(written[0].kind).toBe('new');
    expect(written[0].path).toMatch(/dum_007\.json$/);
  });

  /**
   * The detector must return 'modified' when an existing file was edited.
   * Pre-Phase-2 this returned an empty array → unnecessary retry loop.
   */
  it('reports kind=modified when an existing dum_*.json was edited', async () => {
    const written = await runCapture('modify');
    expect(written.length).toBe(1);
    expect(written[0].kind).toBe('modified');
    expect(written[0].path).toMatch(/dum_005\.json$/);
  });

  /**
   * If the spawned process didn't change anything, the detector returns
   * empty. Critical so the loop knows "CLI produced nothing" → real retry.
   */
  it('returns empty when nothing changed', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.makestudio', 'dums', 'dum_010.json'),
      JSON.stringify({ tempId: 'dum_010' }),
    );
    const past = (Date.now() - 5000) / 1000;
    fs.utimesSync(path.join(tmpDir, '.makestudio', 'dums', 'dum_010.json'), past, past);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnCliAndCapture } = require('./per-requirement-loop-test-exports');
    const written = await spawnCliAndCapture({
      cliCommand: process.execPath,
      cliArgs: ['-e', 'process.exit(0)'], // does nothing
      cwd: tmpDir,
      prompt: '',
    });
    expect(written).toEqual([]);
  });

  /**
   * Touching a file without changing content (mtime updated, hash same)
   * must NOT trigger a 'modified' result — otherwise an idempotent
   * `touch` would generate phantom retries.
   */
  it('ignores mtime-only touches with unchanged content', async () => {
    const target = path.join(tmpDir, '.makestudio', 'dums', 'dum_020.json');
    const content = JSON.stringify({ tempId: 'dum_020', title: 'stable' });
    fs.writeFileSync(target, content);
    const past = (Date.now() - 5000) / 1000;
    fs.utimesSync(target, past, past);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnCliAndCapture } = require('./per-requirement-loop-test-exports');
    // Spawn re-writes the SAME content — mtime advances but hash matches.
    const inline = `require('fs').writeFileSync('${target}', ${JSON.stringify(content)});`;
    const written = await spawnCliAndCapture({
      cliCommand: process.execPath,
      cliArgs: ['-e', inline],
      cwd: tmpDir,
      prompt: '',
    });
    expect(written).toEqual([]);
  });

  // Smoke check: spawnSync as we use it actually runs node from process.execPath.
  // Catches PATH-issues before the rest of the suite gives confusing errors.
  it('node is executable from process.execPath (sanity)', () => {
    const r = spawnSync(process.execPath, ['-e', 'console.log("ok")']);
    expect(r.status).toBe(0);
  });
});
