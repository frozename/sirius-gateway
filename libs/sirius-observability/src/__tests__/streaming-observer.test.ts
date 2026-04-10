import { expect, test, describe, beforeEach, spyOn } from 'bun:test';
import { StreamingObserver } from '../streaming-observer';
import type { UnifiedStreamEvent } from '../../../sirius-core/src/index.js';
import { collectAsync } from '../../../sirius-core/src/__tests__/test-helpers.js';

describe('StreamingObserver', () => {
  let observer: StreamingObserver;
  let loggerSpy: any;
  const metadata = {
    requestId: 'req-123',
    model: 'gpt-4',
    provider: 'openai',
  };

  beforeEach(() => {
    observer = new StreamingObserver();
    loggerSpy = spyOn(observer['logger'], 'log').mockImplementation(() => {});
  });

  test('passes through all events unchanged', async () => {
    const events: UnifiedStreamEvent[] = [
      { type: 'content_delta', delta: 'hello' },
      { type: 'content_delta', delta: ' world' },
    ];
    
    async function* generate() {
      yield* events;
    }

    const stream = observer.observe(generate(), metadata);
    const result = await collectAsync(stream);
    
    expect(result).toEqual(events);
  });

  test('counts chunks', async () => {
    const events: UnifiedStreamEvent[] = [
      { type: 'content_delta', delta: '1' },
      { type: 'content_delta', delta: '2' },
      { type: 'content_delta', delta: '3' },
    ];
    
    async function* generate() {
      yield* events;
    }

    const stream = observer.observe(generate(), metadata);
    await collectAsync(stream);
    
    expect(loggerSpy).toHaveBeenCalled();
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.chunkCount).toBe(3);
  });

  test('counts bytes for content_delta (Buffer.byteLength)', async () => {
    const events: UnifiedStreamEvent[] = [
      { type: 'content_delta', delta: 'hello' }, // 5 bytes
      { type: 'content_delta', delta: ' 👋' }, // 5 bytes
    ];
    
    async function* generate() {
      yield* events;
    }

    const stream = observer.observe(generate(), metadata);
    await collectAsync(stream);
    
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.totalBytes).toBe(10);
  });

  test('captures token usage from usage events', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const events: UnifiedStreamEvent[] = [
      { type: 'content_delta', delta: 'done' },
      { type: 'usage', usage },
    ];
    
    async function* generate() {
      yield* events;
    }

    const stream = observer.observe(generate(), metadata);
    await collectAsync(stream);
    
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.tokenUsage).toEqual(usage);
  });

  test('logs completion summary in finally block', async () => {
    const events: UnifiedStreamEvent[] = [
      { type: 'content_delta', delta: 'ok' },
    ];
    
    async function* generate() {
      yield* events;
    }

    const stream = observer.observe(generate(), metadata);
    await collectAsync(stream);
    
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.message).toBe('Stream completed');
    expect(logCall.requestId).toBe('req-123');
    expect(logCall.model).toBe('gpt-4');
    expect(logCall.provider).toBe('openai');
    expect(logCall.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('logs even if stream errors (finally)', async () => {
    async function* generate() {
      yield { type: 'content_delta', delta: 'fail' } as UnifiedStreamEvent;
      throw new Error('Stream error');
    }

    const stream = observer.observe(generate(), metadata);
    
    try {
      await collectAsync(stream);
    } catch (e) {
      // ignore
    }
    
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.chunkCount).toBe(1);
    expect(logCall.totalBytes).toBe(4);
  });

  test('handles empty stream', async () => {
    async function* generate() {
      // empty
    }

    const stream = observer.observe(generate(), metadata);
    const result = await collectAsync(stream);
    
    expect(result).toEqual([]);
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    const logCall = loggerSpy.mock.calls[0][0];
    expect(logCall.chunkCount).toBe(0);
    expect(logCall.totalBytes).toBe(0);
  });
});
