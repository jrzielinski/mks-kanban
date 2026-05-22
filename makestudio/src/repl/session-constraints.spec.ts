import {
  addConstraint,
  listConstraints,
  clearConstraints,
  formatConstraintsForPrompt,
} from './session-constraints';

const makeCtx = (): any => ({});

describe('add/list/clear constraints (per-ctx storage)', () => {
  it('starts empty', () => {
    expect(listConstraints(makeCtx())).toEqual([]);
  });

  it('addConstraint stores trimmed text and trimmed verifyCommand', () => {
    const ctx = makeCtx();
    addConstraint(ctx, '  Typecheck must pass.  ', '  npx tsc --noEmit  ');
    expect(listConstraints(ctx)).toEqual([
      { text: 'Typecheck must pass.', verifyCommand: 'npx tsc --noEmit' },
    ]);
  });

  it('verifyCommand defaults to null when omitted', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'do not commit without explicit permission');
    expect(listConstraints(ctx)).toEqual([
      { text: 'do not commit without explicit permission', verifyCommand: null },
    ]);
  });

  it('empty/whitespace verifyCommand becomes null', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'rule one', '');
    addConstraint(ctx, 'rule two', '   ');
    expect(listConstraints(ctx)).toEqual([
      { text: 'rule one', verifyCommand: null },
      { text: 'rule two', verifyCommand: null },
    ]);
  });

  it('addConstraint dedupes by text — same text twice is one entry', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'X');
    addConstraint(ctx, 'X');
    addConstraint(ctx, 'X');
    expect(listConstraints(ctx)).toEqual([{ text: 'X', verifyCommand: null }]);
  });

  it('re-pinning with a verifyCommand upgrades the entry (model figures out the verifier later)', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'tests must pass'); // first pin: no command
    addConstraint(ctx, 'tests must pass', 'cargo test'); // upgraded
    expect(listConstraints(ctx)).toEqual([
      { text: 'tests must pass', verifyCommand: 'cargo test' },
    ]);
  });

  it('addConstraint rejects empty/whitespace text', () => {
    const ctx = makeCtx();
    addConstraint(ctx, '');
    addConstraint(ctx, '   ');
    expect(listConstraints(ctx)).toEqual([]);
  });

  it('clearConstraints empties the registry for that ctx', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'A', 'pytest -q');
    addConstraint(ctx, 'B', 'go vet ./...');
    expect(listConstraints(ctx).length).toBe(2);
    clearConstraints(ctx);
    expect(listConstraints(ctx)).toEqual([]);
  });

  it('storage is per-ctx, not global', () => {
    const a = makeCtx();
    const b = makeCtx();
    addConstraint(a, 'rule-a');
    addConstraint(b, 'rule-b');
    expect(listConstraints(a)).toEqual([{ text: 'rule-a', verifyCommand: null }]);
    expect(listConstraints(b)).toEqual([{ text: 'rule-b', verifyCommand: null }]);
  });

  it('preserves insertion order across listConstraints calls', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'first');
    addConstraint(ctx, 'second', 'mvn verify');
    addConstraint(ctx, 'third', 'flutter analyze');
    expect(listConstraints(ctx).map((c) => c.text)).toEqual(['first', 'second', 'third']);
  });

  it('storage is agnostic to language/build-tool — ANY shell command is valid as verifyCommand', () => {
    const ctx = makeCtx();
    // Storage layer must not care about ecosystem. These are all equally
    // valid; the runtime never inspects the command shape.
    const examples = [
      'npx tsc --noEmit',
      'cargo check',
      'pytest -q',
      'flutter analyze',
      'mvn verify',
      'go vet ./...',
      'bundle exec rspec',
      'make test',
      './scripts/check.sh',
    ];
    examples.forEach((cmd, i) => addConstraint(ctx, `rule ${i}`, cmd));
    const list = listConstraints(ctx);
    expect(list).toHaveLength(examples.length);
    expect(list.map((c) => c.verifyCommand)).toEqual(examples);
  });
});

describe('formatConstraintsForPrompt', () => {
  it('returns null when no constraints', () => {
    expect(formatConstraintsForPrompt(makeCtx())).toBeNull();
  });

  it('emits a markdown section with bullets and a verification reminder', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'Typecheck must pass.', 'npx tsc --noEmit');
    addConstraint(ctx, 'Add unit tests for every change.');
    const out = formatConstraintsForPrompt(ctx);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/## Session-pinned constraints/);
    expect(out!).toMatch(/- Typecheck must pass\.\s+_\(verify: `npx tsc --noEmit`\)_/);
    expect(out!).toMatch(/- Add unit tests for every change\./);
    expect(out!).toMatch(/verify each constraint/i);
  });

  it('annotates each constraint with its verifyCommand when present', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'rule', 'cargo test');
    const out = formatConstraintsForPrompt(ctx);
    expect(out).toContain('_(verify: `cargo test`)_');
  });

  it('omits the verify suffix when verifyCommand is absent', () => {
    const ctx = makeCtx();
    addConstraint(ctx, 'do not commit without permission');
    const out = formatConstraintsForPrompt(ctx);
    expect(out).not.toContain('verify:');
  });
});
