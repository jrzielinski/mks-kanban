import { levelForRisk } from './sandbox';

describe('levelForRisk', () => {
  it('returns "readonly" for safe commands', () => {
    expect(levelForRisk('safe')).toBe('readonly');
  });

  it('returns "project" for warn commands', () => {
    expect(levelForRisk('warn')).toBe('project');
  });

  it('returns "project" for dangerous commands too (still sandboxed)', () => {
    expect(levelForRisk('dangerous')).toBe('project');
  });
});
