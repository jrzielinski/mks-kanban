import {
  parseReviewMarkdown,
  hasBlockingFindings,
  buildFixPrompt,
} from './code-reviewer';

const REVIEW_MD = `
# Code Review: DUM-003

## Verdict: FAIL

## Summary
Some serious issues were found.

## Findings

### 1. Missing tenantId on query
- **Severity**: \`critical\`
- **Category**: \`security\`
- **File**: \`src/users/users.service.ts:42\`
- **Confidence**: 9
- **Description**: findById does not filter by tenantId.
- **Recommendation**: Add tenantId to the where clause.

### 2. N+1 query
- **Severity**: \`high\`
- **Category**: \`performance\`
- **File**: \`src/users/users.service.ts\`
- **Confidence**: 8
- **Description**: Looping SELECTs.
- **Recommendation**: Use QueryBuilder with joins.

### 3. Typo in docstring
- **Severity**: \`low\`
- **Category**: \`style\`
- **Confidence**: 3
- **Description**: Comment has a typo.
- **Recommendation**: Fix the typo.
`;

describe('parseReviewMarkdown', () => {
  it('extracts the FAIL verdict', () => {
    const r = parseReviewMarkdown(REVIEW_MD);
    expect(r.verdict).toBe('FAIL');
  });

  it('defaults to PASS when no verdict line is present', () => {
    const r = parseReviewMarkdown('some text');
    expect(r.verdict).toBe('PASS');
  });

  it('captures the summary section', () => {
    const r = parseReviewMarkdown(REVIEW_MD);
    expect(r.summary).toContain('serious issues');
  });

  it('extracts every finding with severity/category/confidence', () => {
    const r = parseReviewMarkdown(REVIEW_MD);
    expect(r.findings.length).toBe(3);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.findings[0].category).toBe('security');
    expect(r.findings[0].confidence).toBe(9);
    expect(r.findings[2].severity).toBe('low');
  });

  it('parses file and line when present', () => {
    const r = parseReviewMarkdown(REVIEW_MD);
    expect(r.findings[0].file).toBe('src/users/users.service.ts');
    expect(r.findings[0].line).toBe(42);
    expect(r.findings[1].file).toBe('src/users/users.service.ts');
    expect(r.findings[1].line).toBeUndefined();
  });

  it('clamps confidence between 1 and 10', () => {
    const evil = REVIEW_MD.replace('Confidence**: 9', 'Confidence**: 999');
    const r = parseReviewMarkdown(evil);
    expect(r.findings[0].confidence).toBe(10);
  });

  it('skips blocks without a severity header', () => {
    const noSev = `### 1. No severity here\n- **Category**: style\n- **Description**: nothing`;
    expect(parseReviewMarkdown(noSev).findings.length).toBe(0);
  });
});

describe('hasBlockingFindings', () => {
  it('returns true when a critical finding has confidence >= 7', () => {
    const report = parseReviewMarkdown(REVIEW_MD);
    expect(hasBlockingFindings(report)).toBe(true);
  });

  it('returns false when all high/critical findings have low confidence', () => {
    const low = REVIEW_MD.replace('Confidence**: 9', 'Confidence**: 3').replace('Confidence**: 8', 'Confidence**: 2');
    const report = parseReviewMarkdown(low);
    expect(hasBlockingFindings(report)).toBe(false);
  });

  it('returns false for an empty report', () => {
    expect(hasBlockingFindings({ verdict: 'PASS', summary: '', findings: [], rawMarkdown: '' })).toBe(false);
  });
});

describe('buildFixPrompt', () => {
  it('includes only blocking findings in the fix prompt', () => {
    const report = parseReviewMarkdown(REVIEW_MD);
    const prompt = buildFixPrompt({ dumNumber: 'DUM-003' }, report);
    expect(prompt).toContain('DUM-003');
    // Prompt lists description + recommendation, not the block title.
    expect(prompt).toContain('findById does not filter by tenantId');
    expect(prompt).toContain('Looping SELECTs');
    // Low-severity typo description should NOT be included.
    expect(prompt).not.toContain('Comment has a typo');
  });

  it('numbers issues starting at 1', () => {
    const report = parseReviewMarkdown(REVIEW_MD);
    const prompt = buildFixPrompt({ dumNumber: 'x' }, report);
    expect(prompt).toContain('Issue 1');
    expect(prompt).toContain('Issue 2');
  });
});
