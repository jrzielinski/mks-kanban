jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(() => false), readFileSync: jest.fn(() => '{}') }));

describe('minimal mcp load test', () => {
  afterAll(() => {
    const { __clearPluginMcpForTests, shutdownMcp } = require('./mcp');
    shutdownMcp();
    __clearPluginMcpForTests();
  });

  it('loads the module', () => {
    const mcp = require('./mcp');
    expect(mcp.registerPluginMcpServer).toBeDefined();
    expect(mcp.getConfiguredMcpServers).toBeDefined();
  });
});
