import { describeImageWithVisionModel, routeImageBlocks, prepareImagesForTurn } from './image-pipeline';

describe('describeImageWithVisionModel', () => {
  it('throws when baseUrl is not configured', async () => {
    await expect(describeImageWithVisionModel({}, 'key', null, 'gpt-4', 'openai'))
      .rejects.toThrow('visionBaseUrl not configured');
  });

  it('normalises baseUrl (strips trailing / and /v1 before re-adding /v1)', async () => {
    // This would throw from fetch in test, but we check the URL construction
    // by examining that the function doesn't double up /v1.
    // We mock fetch to verify the URL.
    const mockFetch = jest.fn().mockRejectedValue(new Error('network'));
    (global as any).fetch = mockFetch;

    await expect(describeImageWithVisionModel(
      { source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      'test-key',
      'https://api.groq.com/openai/v1',
      'llama-vision',
      'groq',
    )).rejects.toThrow('network');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions', // /v1 is re-added after normalisation
      expect.objectContaining({ method: 'POST' }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('llama-vision');
    expect(body.messages[0].content[0].type).toBe('text');
    expect(body.messages[0].content[1].type).toBe('image_url');
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,abc');
  });

  it('reads image from source.url', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('net'));
    (global as any).fetch = mockFetch;

    await expect(describeImageWithVisionModel(
      { source: { type: 'url', url: 'https://example.com/img.png' } },
      'key', 'https://api.openai.com/v1', 'gpt-4o', 'openai',
    )).rejects.toThrow('net');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[1].image_url.url).toBe('https://example.com/img.png');
  });

  it('reads from image_url.url fallback', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('net'));
    (global as any).fetch = mockFetch;

    await expect(describeImageWithVisionModel(
      { image_url: { url: 'https://cdn.com/x.jpg' } },
      'key', 'https://api.openai.com/v1', 'gpt-4o', 'openai',
    )).rejects.toThrow('net');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[1].image_url.url).toBe('https://cdn.com/x.jpg');
  });

  it('throws on unsupported format', async () => {
    await expect(describeImageWithVisionModel(
      { unknown: true },
      'key', 'https://api.openai.com/v1', 'gpt-4o', 'openai',
    )).rejects.toThrow('Unsupported image block format');
  });

  it('uses MAKESTUDIO_VISION_TIMEOUT_MS env var', async () => {
    process.env.MAKESTUDIO_VISION_TIMEOUT_MS = '5000';
    const mockFetch = jest.fn().mockRejectedValue(new Error('timeout'));
    (global as any).fetch = mockFetch;
    await expect(describeImageWithVisionModel(
      { source: { type: 'base64', data: 'x' } },
      'key', 'https://api.openai.com/v1', 'gpt-4o', 'openai',
    )).rejects.toThrow('timeout');
    delete process.env.MAKESTUDIO_VISION_TIMEOUT_MS;
  });
});

describe('routeImageBlocks', () => {
  it('returns input unchanged when no image blocks', async () => {
    const result = await routeImageBlocks([], 'hello', 'hello', {} as any);
    expect(result.effectiveInput).toBe('hello');
    expect(result.effectiveImageBlocks).toEqual([]);
    expect(result.visionStripped).toBe(false);
  });

  it('returns input unchanged when provider supports vision', async () => {
    const blocks = [{ source: { type: 'base64', data: 'x' } }];
    const ctx: any = { providerInfo: { supportsVision: true } };
    const result = await routeImageBlocks(blocks, 'hello', 'hello', ctx);
    expect(result.effectiveImageBlocks).toHaveLength(1);
    expect(result.visionStripped).toBe(false);
  });

  it('strips images when provider lacks vision and no vision config', async () => {
    const blocks = [{ source: { type: 'base64', data: 'x' } }];
    const ctx: any = { providerInfo: { supportsVision: false } };
    const result = await routeImageBlocks(blocks, 'hello [Image #1]', 'hello [Image #1]', ctx);
    expect(result.effectiveImageBlocks).toEqual([]);
    expect(result.visionStripped).toBe(true);
    expect(result.effectiveInput).not.toContain('[Image #1]');
    expect(result.effectiveInput).toContain('does not support vision');
  });

  it('routes through vision model when configured', async () => {
    const blocks = [{ source: { type: 'base64', data: 'abc' } }];
    const ctx: any = {
      providerInfo: {
        supportsVision: false,
        visionModel: 'gpt-4o',
        visionApiKey: 'key-123',
        visionBaseUrl: 'https://api.openai.com/v1',
        visionProvider: 'openai',
      },
    };
    const result = await routeImageBlocks(blocks, 'desc', 'desc', ctx);
    // Vision model failed (no fetch mock), so description is error text
    expect(result.effectiveInput).toContain('vision model error');
    expect(result.effectiveImageBlocks).toEqual([]);
    expect(result.visionStripped).toBe(true);
  });
});

describe('prepareImagesForTurn', () => {
  it('returns original input when no image-paste module', async () => {
    const result = await prepareImagesForTurn('hello', {} as any);
    expect(result.effectiveInput).toBe('hello');
    expect(result.effectiveImageBlocks).toEqual([]);
    expect(result.visionStripped).toBe(false);
  });
});
