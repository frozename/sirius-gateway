import { describe, it, expect } from 'bun:test';
import { parseOllamaStream } from '../ollama.stream-parser';
import { OLLAMA_NDJSON_FIXTURE } from '../../../../libs/sirius-core/src/__tests__/fixtures';

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
});
