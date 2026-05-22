// @ts-nocheck
jest.mock('../../security', () => ({ analyzeCommand: jest.fn(), requestApproval: jest.fn() }));
jest.mock('../../sandbox', () => ({ execSandboxed: jest.fn(), levelForRisk: jest.fn(() => 'none'), detectSandboxBackend: jest.fn(() => 'docker') }));
jest.mock('child_process', () => ({ execSync: jest.fn() }));

const mod = require('./shell');

beforeEach(() => jest.clearAllMocks());

describe('SHELL_TOOL_HANDLERS', () => {
  it('exports handlers array with name and function', () => {
    expect(mod.SHELL_TOOL_HANDLERS).toHaveLength(1);
    expect(mod.SHELL_TOOL_HANDLERS[0].name).toBe('shell_run');
    expect(typeof mod.SHELL_TOOL_HANDLERS[0].handler).toBe('function');
  });
});

describe('toolShellRun', () => {
  const sec = require('../../security');
  const sand = require('../../sandbox');

  it('returns error when command is missing', async () => {
    const r = JSON.parse(await mod.toolShellRun({}, {}));
    expect(r.error).toContain('required');
  });

  it('blocked by security for dangerous command', async () => {
    sec.analyzeCommand.mockReturnValue({ risk: 'dangerous', reasons: ['rm -rf'] });
    sec.requestApproval.mockResolvedValue(false);
    const r = JSON.parse(await mod.toolShellRun({ command: 'rm -rf /' }, {}));
    expect(r.error).toContain('Blocked');
    expect(r.risk).toBe('dangerous');
  });

  it('runs approved dangerous command', async () => {
    sec.analyzeCommand.mockReturnValue({ risk: 'dangerous', reasons: ['rm -rf'] });
    sec.requestApproval.mockResolvedValue(true);
    sand.execSandboxed.mockReturnValue({ exitCode: 0, stdout: 'ok', stderr: '', sandboxed: true });
    const r = await mod.toolShellRun({ command: 'rm -rf /' }, {});
    expect(r).toContain('ok');
  });

  it('returns error output on non-zero exit', async () => {
    sec.analyzeCommand.mockReturnValue({ risk: 'safe', reasons: [] });
    sand.execSandboxed.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'permission denied', sandboxed: true });
    const r = JSON.parse(await mod.toolShellRun({ command: 'ls /root' }, {}));
    expect(r.error).toContain('Command exited with code 1');
    expect(r.stderr).toContain('permission denied');
  });

  it('warns for medium risk commands', async () => {
    sec.analyzeCommand.mockReturnValue({ risk: 'warn', reasons: ['network access'] });
    sand.execSandboxed.mockReturnValue({ exitCode: 0, stdout: 'done', stderr: '', sandboxed: false });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await mod.toolShellRun({ command: 'curl http://x' }, {});
    expect(spy).toHaveBeenCalled();
    expect(r).toContain('[no sandbox');
    spy.mockRestore();
  });
});
