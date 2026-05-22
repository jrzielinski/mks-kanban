import { execSync } from 'child_process';

// We test that the modules export the right shape
// Actual git execution is tested via e2e; here we verify the contract.

describe('GIT_TOOL_HANDLERS', () => {
  it('exports GIT_TOOL_HANDLERS array', () => {
    const mod = require('./git');
    expect(Array.isArray(mod.GIT_TOOL_HANDLERS)).toBe(true);
  });

  it('exports git_status handler', () => {
    const mod = require('./git');
    const entry = mod.GIT_TOOL_HANDLERS.find((h: any) => h.name === 'git_status');
    expect(entry).toBeDefined();
    expect(typeof entry.handler).toBe('function');
  });

  it('exports git_log handler', () => {
    const mod = require('./git');
    const entry = mod.GIT_TOOL_HANDLERS.find((h: any) => h.name === 'git_log');
    expect(entry).toBeDefined();
    expect(typeof entry.handler).toBe('function');
  });
});
