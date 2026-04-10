import { describe, it, expect } from 'bun:test';
import { parseOpenAiStream } from '../openai.stream-parser';
import { OPENAI_SSE_FIXTURE } from '../../../../libs/sirius-core/src/__tests__/fixtures';

function createMockResponse(sseString: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseString));
      controller.close();
    },
  });

  return {
    body: stream,
  } as Response;
}

describe('parseOpenAiStream', () => {
  it('parses standard content deltas and [DONE]', async () => {
    const response = createMockResponse(OPENAI_SSE_FIXTURE);
    const events = [];
    for await (const event of parseOpenAiStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'Hello' });
    expect(events[1]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses tool call deltas', async () => {
    const sse = 'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"index":0,"finish_reason":null}]}\n\n' +
                'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":\\"London\\"}"}}]},"index":0,"finish_reason":null}]}\n\n' +
                'data: {"id":"1","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n' +
                'data: [DONE]';
    
    const response = createMockResponse(sse);
    const events = [];
    for await (const event of parseOpenAiStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '',
    });
    expect(events[1]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: undefined,
      name: undefined,
      argumentsDelta: '{"location":"London"}',
    });
    expect(events[2]).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('handles usage information', async () => {
    const sse = 'data: {"id":"1","choices":[{"delta":{"content":"Hi"},"index":0,"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
                'data: [DONE]';
    
    const response = createMockResponse(sse);
    const events = [];
    for await (const event of parseOpenAiStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'Hi' });
    expect(events[1]).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('skips malformed lines and empty lines', async () => {
    const sse = '\n: comment\n' +
                'invalid line\n' +
                'data: {"invalid": "json"\n' +
                'data: {"id":"1","choices":[{"delta":{"content":"Valid"},"index":0,"finish_reason":null}]}\n\n' +
                'data: [DONE]';
    
    const response = createMockResponse(sse);
    const events = [];
    for await (const event of parseOpenAiStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'Valid' });
  });
});
