import { execSync } from 'child_process';

describe('DUM_TOOL_HANDLERS', () => {
  it('exports the handlers array', () => {
    const mod = require('./dum');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    expect(key).toBeDefined();
    // @ts-ignore
    expect(Array.isArray(mod[key])).toBe(true);
  });

  it('each handler entry has name and function', () => {
    const mod = require('./dum');
    const key = Object.keys(mod).find(k => k.endsWith('_TOOL_HANDLERS'));
    // @ts-ignore
    for (const entry of mod[key]) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.handler).toBe('function');
    }
  });
});
