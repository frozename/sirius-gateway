import { describe, it, expect } from 'bun:test';
import { parseAnthropicStream } from '../anthropic.stream-parser';
import { ANTHROPIC_SSE_FIXTURE } from '../../../../libs/sirius-core/src/__tests__/fixtures';

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

describe('parseAnthropicStream', () => {
  it('parses standard content deltas and message lifecycle', async () => {
    const response = createMockResponse(ANTHROPIC_SSE_FIXTURE);
    const events = [];
    for await (const event of parseAnthropicStream(response)) {
      events.push(event);
    }

    // Fixture has: message_start, content_block_start (text), content_block_delta (Hello), content_block_stop, message_delta (stop), message_stop
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    });
    expect(events[1]).toEqual({ type: 'content_delta', delta: 'Hello' });
    expect(events[2]).toEqual({
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 },
    });
    expect(events[3]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('parses tool use stream', async () => {
    const sse = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "claude-3", "usage": {"input_tokens": 50, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "call_1", "name": "get_weather", "input": {}}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\\"locat"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "ion\\": \\"SF\\"}"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 20}}

event: message_stop
data: {"type": "message_stop"}`;

    const response = createMockResponse(sse);
    const events = [];
    for await (const event of parseAnthropicStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(6);
    expect(events[0]!.type).toBe('usage');
    expect(events[1]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '',
    });
    expect(events[2]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: '{"locat',
    });
    expect(events[3]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'get_weather',
      argumentsDelta: 'ion": "SF"}',
    });
    expect(events[4]!.type).toBe('usage');
    expect(events[5]).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });
});
