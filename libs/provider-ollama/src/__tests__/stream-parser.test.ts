import { describe, it, expect } from 'bun:test';
import { parseOllamaStream } from '../ollama.stream-parser';
import { OLLAMA_NDJSON_FIXTURE } from '../../../../libs/sirius-core/src/__tests__/fixtures';
import type { UnifiedStreamEvent } from '@sirius/core';

function createMockResponse(ndjsonString: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(ndjsonString));
      controller.close();
    },
  });

  return {
    body: stream,
  } as Response;
}

async function collectEvents(ndjson: string): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const event of parseOllamaStream(createMockResponse(ndjson))) {
    events.push(event);
  }
  return events;
}

describe('parseOllamaStream', () => {
  it('parses standard content deltas and final usage', async () => {
    const response = createMockResponse(OLLAMA_NDJSON_FIXTURE);
    const events = [];
    for await (const event of parseOllamaStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'Hello' });
    expect(events[1]).toEqual({
      type: 'usage',
      usage: { inputTokens: 26, outputTokens: 282, totalTokens: 308 },
    });
    expect(events[2]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses tool calls', async () => {
    const ndjson = `{"model":"llama2","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"location":"London"}}}]},"done":false}
{"model":"llama2","done":true,"prompt_eval_count":10,"eval_count":5}`;

    const response = createMockResponse(ndjson);
    const events = [];
    for await (const event of parseOllamaStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('tool_call_delta');
    expect((events[0] as any).index).toBe(0);
    expect((events[0] as any).name).toBe('get_weather');
    expect((events[0] as any).argumentsDelta).toBe('{"location":"London"}');
    expect(events[1]).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(events[2]).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  // #14: the final chunk's done_reason decides between 'length' and 'stop'.
  it('maps done_reason length on the final chunk to finishReason length', async () => {
    const ndjson =
      '{"message":{"role":"assistant","content":"Hi"},"done":false}\n' +
      '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"length","eval_count":1}\n';

    const events = await collectEvents(ndjson);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hi' },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } },
      { type: 'done', finishReason: 'length' },
    ]);
  });

  it('maps done_reason stop on the final chunk to finishReason stop', async () => {
    const ndjson =
      '{"message":{"role":"assistant","content":"Hi"},"done":false}\n' +
      '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":1}\n';

    const events = await collectEvents(ndjson);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hi' },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 1, totalTokens: 1 } },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('keeps tool_calls when the final chunk after a tool call says length', async () => {
    const ndjson =
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_weather","arguments":{"city":"SF"}}}]},"done":false}\n' +
      '{"message":{"role":"assistant","content":""},"done":true,"done_reason":"length","eval_count":4}\n';

    const events = await collectEvents(ndjson);

    expect(events.map((event) => event.type)).toEqual(['tool_call_delta', 'usage', 'done']);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });
});
