import { buildQueueItem } from './offline-queue';

describe('buildQueueItem', () => {
  it('stamps createdAt from the injected clock', () => {
    const fixed = new Date('2026-04-19T10:00:00.000Z');
    const item = buildQueueItem(
      { type: 'import', method: 'POST', url: '/x', body: {}, description: 'x' },
      fixed,
      () => 0.123456789,
    );
    expect(item.createdAt).toBe(fixed.toISOString());
  });

  it('derives a deterministic id from the clock and random', () => {
    const fixed = new Date('2026-04-19T10:00:00.000Z');
    const item = buildQueueItem(
      { type: 'audit', method: 'PUT', url: '/y', body: {}, description: 'y' },
      fixed,
      () => 0.999,
    );
    expect(item.id.startsWith(String(fixed.getTime()) + '-')).toBe(true);
  });

  it('initializes retries to 0', () => {
    const item = buildQueueItem(
      { type: 'analysis-update', method: 'POST', url: '/z', body: {}, description: 'z' },
    );
    expect(item.retries).toBe(0);
  });

  it('preserves every input field on top of the generated ones', () => {
    const body = { hello: 'world' };
    const item = buildQueueItem(
      { type: 'import', method: 'POST', url: '/api', body, description: 'd' },
    );
    expect(item.type).toBe('import');
    expect(item.method).toBe('POST');
    expect(item.url).toBe('/api');
    expect(item.body).toEqual(body);
    expect(item.description).toBe('d');
  });
});
