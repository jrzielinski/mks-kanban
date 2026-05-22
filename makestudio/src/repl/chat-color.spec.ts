/**
 * Smoke test for `/color` plumbing — confirms the slash-command palette
 * stays in sync with the Settings type and that `inputBorderColor()`
 * honours an override when one is set.
 *
 * We avoid spinning up the whole REPL — instead we drive `loadSettings` /
 * `saveSettings` against a temp HOME so the test doesn't touch the real
 * `~/.makestudio/settings.json`.
 */
import * as fs from 'fs';
import * as realOs from 'os';
import * as path from 'path';

// Pin os.homedir() to a tmp dir so saveSettings hits a throwaway
// settings.json instead of the developer's real ~/.makestudio.
// Without this Node's cached homedir() ignored process.env.HOME and
// the test corrupted the user's real settings file.
let tmpHomeShared: string;
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => tmpHomeShared };
});

describe('/color chat-bar accent', () => {
  beforeEach(() => {
    tmpHomeShared = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ms-color-'));
    jest.resetModules();
  });
  afterEach(() => {
    try { fs.rmSync(tmpHomeShared, { recursive: true, force: true }); } catch { /* */ }
  });

  it('chatColorNames lists default + every named accent', () => {
    const { chatColorNames } = require('./theme');
    const names = chatColorNames();
    expect(names[0]).toBe('default');
    for (const c of ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']) {
      expect(names).toContain(c);
    }
  });

  it('inputBorderColor falls back to theme.inputBorder when chatColor=default', () => {
    const { saveSettings } = require('./settings');
    const { inputBorderColor } = require('./theme');
    saveSettings({ theme: 'default', chatColor: 'default' });
    // Default theme's inputBorder slot is 'cyan'.
    expect(inputBorderColor()).toBe('cyan');
  });

  it('inputBorderColor respects an explicit chatColor override', () => {
    const { saveSettings } = require('./settings');
    const { inputBorderColor } = require('./theme');
    saveSettings({ chatColor: 'red' });
    expect(inputBorderColor()).toBe('red');
    saveSettings({ chatColor: 'blue' });
    expect(inputBorderColor()).toBe('blue');
  });

  it('purple maps to Ink-supported magenta (no native `purple` in Ink)', () => {
    const { saveSettings } = require('./settings');
    const { inputBorderColor } = require('./theme');
    saveSettings({ chatColor: 'purple' });
    expect(inputBorderColor()).toBe('magenta');
  });

  it('orange / pink resolve to hex values (no native Ink names)', () => {
    const { saveSettings } = require('./settings');
    const { inputBorderColor } = require('./theme');
    saveSettings({ chatColor: 'orange' });
    expect(inputBorderColor()).toMatch(/^#/);
    saveSettings({ chatColor: 'pink' });
    expect(inputBorderColor()).toMatch(/^#/);
  });

  it('unknown chatColor value is ignored (falls back to theme)', () => {
    const { saveSettings } = require('./settings');
    const { inputBorderColor } = require('./theme');
    // Slip in an unknown value bypassing the slash-command validator.
    saveSettings({ chatColor: 'neon' as any });
    // Should fall through to the active theme's inputBorder ('cyan' for default).
    expect(inputBorderColor()).toBe('cyan');
  });
});
