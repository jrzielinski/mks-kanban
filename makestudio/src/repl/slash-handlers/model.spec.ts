import { formatVersionBlock, VersionBlockData } from './model';

// Strip ANSI escapes so the assertions work against plain text. chalk
// (which the formatter uses for cyan/dim/bold) emits SGR sequences that
// break literal substring matching.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

const baseData: VersionBlockData = {
  agent: { version: '0.1.998', gitCommit: '492ca0f8' },
  backend: {
    version: '2.1.405+0',
    gitCommit: 'f04f3603',
    status: 'ok',
    environment: 'production',
    uptime: '5.2h',
  },
  server: 'https://api.zielinski.dev.br',
  node: 'v25.9.0',
  platform: 'linux-x64',
  build: '2026-05-05',
};

describe('formatVersionBlock', () => {
  it('renders all 7 expected rows + opening + closing', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    const lines = out.split('\n');
    expect(lines.length).toBe(8);
    expect(lines[0]).toMatch(/✦ makestudio/);
    expect(lines[lines.length - 1]).toMatch(/└──/);
  });

  it('puts agent + version + commit on the second line', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    expect(out).toMatch(/agent\s+v0\.1\.998 @ 492ca0f8/);
  });

  it('puts backend + version + commit + status meta on the third line', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    expect(out).toMatch(/backend\s+v2\.1\.405\+0 @ f04f3603\s+\(ok · production · up 5\.2h\)/);
  });

  it('elides the agent gitCommit suffix when null', () => {
    const out = stripAnsi(formatVersionBlock({
      ...baseData,
      agent: { version: '0.1.0', gitCommit: null },
    }));
    const agentLine = out.split('\n').find((l) => l.includes('agent'))!;
    expect(agentLine).toMatch(/agent\s+v0\.1\.0$/);
    expect(agentLine).not.toMatch(/@/);
  });

  it('elides "—" placeholders in the backend meta block', () => {
    const out = stripAnsi(formatVersionBlock({
      ...baseData,
      backend: {
        version: 'unreachable',
        gitCommit: null,
        status: 'unreachable',
        environment: '—',
        uptime: '—',
      },
    }));
    // env=— and uptime=— should be filtered out — only `unreachable` shown.
    expect(out).toMatch(/\(unreachable\)/);
    expect(out).not.toMatch(/—/);
  });

  it('emits a single block (no blank lines between rows)', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    // Every line should start with two-space indent + box-drawing char.
    // No row should be empty.
    const lines = out.split('\n');
    for (const l of lines) {
      expect(l.length).toBeGreaterThan(0);
    }
  });

  it('aligns the labels to a fixed-width column (left edge of values lines up)', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    const rowMatchers = [/agent\s+v/, /backend\s+v/, /server\s+http/, /node\s+v/, /platform\s+linux/, /build\s+\d/];
    for (const re of rowMatchers) expect(out).toMatch(re);
    // Pull the column position of "v" on agent row and "h" on server row;
    // they should be at the SAME index (LABEL_W=9 with one trailing space).
    const lines = out.split('\n');
    const agentRow = lines.find((l) => l.includes('agent'))!;
    const serverRow = lines.find((l) => l.includes('server'))!;
    expect(agentRow.indexOf('v0.1.998')).toBe(serverRow.indexOf('https'));
  });

  it('renders the server URL verbatim (no truncation, no scheme rewrite)', () => {
    const out = stripAnsi(formatVersionBlock(baseData));
    expect(out).toMatch(/https:\/\/api\.zielinski\.dev\.br/);
  });
});
