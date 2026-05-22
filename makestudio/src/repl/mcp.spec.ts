jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(() => false), readFileSync: jest.fn(() => '{}') }));
jest.mock('os', () => ({ homedir: jest.fn(() => '/home/test') }));

const mcp = require('./mcp');
const fs = require('fs');

beforeEach(() => { mcp.__clearPluginMcpForTests(); mcp.shutdownMcp(); });
afterEach(() => { mcp.shutdownMcp(); mcp.__clearPluginMcpForTests(); });

describe('registerPluginMcpServer', () => {
  it('registers a plugin', () => {
    mcp.registerPluginMcpServer({ name: 'p', command: 'node' });
    expect(mcp.getConfiguredMcpServers()).toContain('p');
  });
  it('throws if name empty', () => {
    expect(() => mcp.registerPluginMcpServer({ name: '', command: 'x' })).toThrow();
  });
  it('throws if command empty', () => {
    expect(() => mcp.registerPluginMcpServer({ name: 'x', command: '' })).toThrow();
  });
});

describe('getConfiguredMcpServers', () => {
  it('returns union of disk + plugin', () => {
    mcp.registerPluginMcpServer({ name: 'plug', command: 'x' });
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ mcpServers: { disk: { command: 'd' } } }));
    const list = mcp.getConfiguredMcpServers('/x');
    expect(list).toEqual(expect.arrayContaining(['plug', 'disk']));
  });
  it('returns only plugins when no cwd', () => {
    mcp.registerPluginMcpServer({ name: 'only', command: 'x' });
    expect(mcp.getConfiguredMcpServers()).toEqual(['only']);
  });
  it('survives fs.existsSync throw', () => {
    fs.existsSync.mockImplementation(() => { throw new Error('boom'); });
    mcp.registerPluginMcpServer({ name: 's', command: 'x' });
    expect(mcp.getConfiguredMcpServers('/x')).toEqual(['s']);
  });
});
