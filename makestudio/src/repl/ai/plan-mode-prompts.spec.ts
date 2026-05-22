import {
  ENTER_PLAN_MODE_PROMPT,
  EXIT_PLAN_MODE_PROMPT,
  ENTER_PLAN_MODE_WORKFLOW_MESSAGE,
} from './plan-mode-prompts';

describe('ENTER_PLAN_MODE_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof ENTER_PLAN_MODE_PROMPT).toBe('string');
    expect(ENTER_PLAN_MODE_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions EnterPlanMode tool', () => {
    expect(ENTER_PLAN_MODE_PROMPT).toContain('EnterPlanMode');
  });

  it('mentions AskUserQuestion', () => {
    expect(ENTER_PLAN_MODE_PROMPT).toContain('AskUserQuestion');
  });

  it('covers when to use and when not to use', () => {
    expect(ENTER_PLAN_MODE_PROMPT).toContain('When to Use');
    expect(ENTER_PLAN_MODE_PROMPT).toContain('When NOT to Use');
  });
});

describe('EXIT_PLAN_MODE_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof EXIT_PLAN_MODE_PROMPT).toBe('string');
    expect(EXIT_PLAN_MODE_PROMPT.length).toBeGreaterThan(50);
  });

  it('mentions ExitPlanMode', () => {
    expect(EXIT_PLAN_MODE_PROMPT).toContain('ExitPlanMode');
  });

  it('mentions AskUserQuestion', () => {
    expect(EXIT_PLAN_MODE_PROMPT).toContain('AskUserQuestion');
  });
});

describe('ENTER_PLAN_MODE_WORKFLOW_MESSAGE', () => {
  it('is a non-empty string', () => {
    expect(typeof ENTER_PLAN_MODE_WORKFLOW_MESSAGE).toBe('string');
    expect(ENTER_PLAN_MODE_WORKFLOW_MESSAGE.length).toBeGreaterThan(50);
  });

  it('mentions plan mode', () => {
    expect(ENTER_PLAN_MODE_WORKFLOW_MESSAGE).toContain('plan mode');
  });
});
