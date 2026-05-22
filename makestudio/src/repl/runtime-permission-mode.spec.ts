/**
 * Runtime-only permission-mode override.
 *
 * Regression test for the bug where `makestudio -p --yes` persisted
 * `permissionMode: bypassPermissions` to ~/.makestudio/settings.json,
 * contaminating every subsequent REPL session (the user saw a red
 * `[mode:bypassPermissions]` badge with no clue why).
 *
 * The fix scopes the override to a single subprocess via the env var
 * `MAKESTUDIO_RUNTIME_PERMISSION_MODE`. `loadSettings()` honours it but
 * NEVER writes it to disk; the on-disk settings stay clean.
 */
import * as fs from 'fs';
import * as realOs from 'os';
import * as path from 'path';

// Pin os.homedir() to a tmp dir so saveSettings/loadSettings hit a
// throwaway settings.json instead of the developer's real
// ~/.makestudio/settings.json. Node caches homedir() in some versions
// so flipping process.env.HOME is unreliable; mocking the module is
// the only fully-deterministic option.
let tmpHomeShared: string;
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => tmpHomeShared };
});

describe('MAKESTUDIO_RUNTIME_PERMISSION_MODE override', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpHomeShared = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ms-runtime-pm-'));
    originalEnv = process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE;
    delete process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE;
    jest.resetModules();
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE;
    else process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = originalEnv;
    try { fs.rmSync(tmpHomeShared, { recursive: true, force: true }); } catch { /* */ }
  });

  it('without override, loadSettings returns the on-disk permissionMode', () => {
    const { saveSettings, loadSettings } = require('./settings');
    saveSettings({ permissionMode: 'plan' });
    expect(loadSettings().permissionMode).toBe('plan');
  });

  it('env-var override beats the on-disk value (returned by loadSettings)', () => {
    const { saveSettings, loadSettings } = require('./settings');
    saveSettings({ permissionMode: 'plan' });
    process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = 'bypassPermissions';
    expect(loadSettings().permissionMode).toBe('bypassPermissions');
  });

  it('runtime override is NOT persisted by saveSettings (sibling field stays clean)', () => {
    // Two-call pattern: saveSettings goes to disk, applyRuntimeOverrides
    // is a read-time wrapper. So calling saveSettings AGAIN to update an
    // unrelated field must NOT inadvertently persist the runtime override.
    const { saveSettings, loadSettings } = require('./settings');
    process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = 'bypassPermissions';
    saveSettings({ outputStyle: 'terse' });
    // loadSettings still sees override (env-var wins)
    expect(loadSettings().permissionMode).toBe('bypassPermissions');
    // Drop the override and bust the cache the way a fresh subprocess would.
    delete process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE;
    jest.resetModules();
    const fresh = require('./settings');
    // The disk-loaded value must NOT be 'bypassPermissions' — the runtime
    // override never bled into saveSettings.
    expect(fresh.loadSettings().permissionMode).not.toBe('bypassPermissions');
  });

  it('removing the env var restores the on-disk value (no leak across runs)', () => {
    const { saveSettings, loadSettings } = require('./settings');
    saveSettings({ permissionMode: 'plan' });
    process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = 'bypassPermissions';
    expect(loadSettings().permissionMode).toBe('bypassPermissions');
    delete process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE;
    // Need to bust the in-module cache the same way a fresh subprocess would.
    jest.resetModules();
    const settingsAgain = require('./settings');
    expect(settingsAgain.loadSettings().permissionMode).toBe('plan');
  });

  it('invalid env value is ignored (falls through to on-disk)', () => {
    const { saveSettings, loadSettings } = require('./settings');
    saveSettings({ permissionMode: 'default' });
    process.env.MAKESTUDIO_RUNTIME_PERMISSION_MODE = 'totally-bogus';
    expect(loadSettings().permissionMode).toBe('default');
  });
});
