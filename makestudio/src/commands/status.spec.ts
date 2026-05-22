import { formatStatusBlock, StatusBlockData } from './status';

// chalk colour codes are SGR escape sequences; strip them so assertions
// match the visible content.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

const baseData: StatusBlockData = {
  serverUrl: 'https://api.zielinski.dev.br',
  tenantId: 'staff',
  clis: [
    { name: 'makestudio', version: '0.1.1009' },
    { name: 'claude', version: '2.1.129' },
  ],
  license: {
    plan: 'enterprise',
    seats: { used: 1, total: 100 },
    tasks: { used: 0, total: 99999 },
  },
  agents: [],
};

describe('formatStatusBlock — single-block, label-aligned, no blank rows', () => {
  it('opens with the makestudio header and closes with the └── corner', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/✦ makestudio · status/);
    expect(lines[lines.length - 1]).toMatch(/└──/);
  });

  it('renders no blank rows — every line carries content', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    for (const line of out.split('\n')) {
      // Each row is at least the indent + box-drawing char, so a fully
      // empty line means we left a hole in the block.
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('aligns label-column values across rows (servidor/tenant/CLIs/plano)', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    const lines = out.split('\n');
    const findCol = (label: string) => {
      const row = lines.find((l) => l.includes(label))!;
      // Column where the value starts = first non-space after the label.
      return row.indexOf(label) + label.length;
    };
    // The padded labels (LABEL_W=9) plus the trailing space form the
    // value column. All padded labels have the same start position.
    const tenantStart = lines.find((l) => l.includes('tenant'))!.indexOf('staff');
    const serverStart = lines.find((l) => l.includes('servidor'))!.indexOf('https');
    expect(tenantStart).toBe(serverStart);
  });

  it('renders CLIs separated by a middle dot, not commas (single-line densely packed)', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    expect(out).toMatch(/makestudio \(0\.1\.1009\)/);
    expect(out).toMatch(/claude \(2\.1\.129\)/);
    expect(out).toMatch(/·/);
  });

  it('renders the licence row with plan UPPERCASE and seats/tasks meta in parens', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    expect(out).toMatch(/plano\s+ENTERPRISE/);
    expect(out).toMatch(/1\/100 seats/);
    expect(out).toMatch(/0\/99999 tasks/);
  });

  it('emits "nenhum conectado" inline when agents is an empty array', () => {
    const out = stripAnsi(formatStatusBlock(baseData));
    expect(out).toMatch(/agents\s+nenhum conectado/);
  });

  it('skips the licence row entirely when license is null (no blank space, no row)', () => {
    const out = stripAnsi(formatStatusBlock({ ...baseData, license: null }));
    expect(out).not.toMatch(/plano/);
    // Block stays contiguous — last row before └── is "agents".
    const lines = out.split('\n');
    const lastBeforeCorner = lines[lines.length - 2];
    expect(lastBeforeCorner).toMatch(/agents/);
  });

  it('skips the agents row entirely when agents is null (offline server)', () => {
    const out = stripAnsi(formatStatusBlock({ ...baseData, agents: null }));
    expect(out).not.toMatch(/agents/);
  });

  it('lists multiple connected agents one per row, indented to the value column', () => {
    const out = stripAnsi(formatStatusBlock({
      ...baseData,
      agents: [
        { hostname: 'host-a', availableCLIs: ['claude'], status: 'idle' },
        { hostname: 'host-b', availableCLIs: ['codex', 'gemini'], status: 'busy' },
      ],
    }));
    expect(out).toMatch(/agents\s+● host-a — claude \(idle\)/);
    expect(out).toMatch(/● host-b — codex, gemini \(busy\)/);
    // Second agent shouldn't have its own "agents" label — the column
    // is just whitespace under the label.
    const lines = out.split('\n');
    const hostBLine = lines.find((l) => l.includes('host-b'))!;
    expect(hostBLine).not.toMatch(/agents/);
  });

  it('falls back to a "no CLIs detected" hint when the list is empty', () => {
    const out = stripAnsi(formatStatusBlock({ ...baseData, clis: [] }));
    expect(out).toMatch(/CLIs\s+nenhum CLI de IA detectado/);
  });

  it('shows the licence plan placeholder when plan field is missing', () => {
    const out = stripAnsi(formatStatusBlock({
      ...baseData,
      license: { seats: { used: 0, total: 0 } },
    }));
    expect(out).toMatch(/plano\s+—/);
  });

  it('omits the licence meta parens when neither seats nor tasks are present', () => {
    const out = stripAnsi(formatStatusBlock({
      ...baseData,
      license: { plan: 'free' },
    }));
    expect(out).toMatch(/plano\s+FREE\s*$/m);
    expect(out).not.toMatch(/seats/);
    expect(out).not.toMatch(/tasks/);
  });
});
