import { describe, it, expect } from 'bun:test';
import { parseAnthropicStream } from '../anthropic.stream-parser';
import { ANTHROPIC_SSE_FIXTURE } from '../../../../libs/sirius-core/src/__tests__/fixtures';
import type { UnifiedStreamEvent } from '@sirius/core';

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

type ToolCallDelta = Extract<UnifiedStreamEvent, { type: 'tool_call_delta' }>;

/** One `data:` line per frame; the parser ignores `event:` lines. */
function sseFrom(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
}

async function collectToolDeltas(sse: string): Promise<ToolCallDelta[]> {
  const out: ToolCallDelta[] = [];
  for await (const event of parseAnthropicStream(createMockResponse(sse))) {
    if (event.type === 'tool_call_delta') {
      out.push(event);
    }
  }
  return out;
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-3',
    usage: { input_tokens: 5, output_tokens: 1 },
  },
};

const MESSAGE_END = [
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
];

function textBlock(index: number, text: string): unknown[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
}

function toolBlock(index: number, id: string, name: string, fragments: string[]): unknown[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...fragments.map((partial_json) => ({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index },
  ];
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
      argumentsDelta: '{"locat',
    });
    expect(events[3]).toEqual({
      type: 'tool_call_delta',
      index: 0,
      argumentsDelta: 'ion": "SF"}',
    });
    expect(events[4]!.type).toBe('usage');
    expect(events[5]).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  // #9: tool_calls[].index counts tool_use blocks from 0, and id/name
  // ride only on the first fragment of each tool call.
  it('maps tool_use after a text block to tool index 0', async () => {
    const sse = sseFrom([
      MESSAGE_START,
      ...textBlock(0, 'Checking.'),
      ...toolBlock(1, 'toolu_1', 'get_weather', ['{"city":', '"SF"}']),
      ...MESSAGE_END,
    ]);

    expect(await collectToolDeltas(sse)).toStrictEqual([
      { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '"SF"}' },
    ]);
  });

  it('numbers two tool_use blocks after a text block 0 and 1', async () => {
    const sse = sseFrom([
      MESSAGE_START,
      ...textBlock(0, 'Checking both.'),
      ...toolBlock(1, 'toolu_1', 'get_weather', ['{"city":', '"SF"}']),
      ...toolBlock(2, 'toolu_2', 'get_time', ['{"tz":', '"UTC"}']),
      ...MESSAGE_END,
    ]);

    expect(await collectToolDeltas(sse)).toStrictEqual([
      { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"city":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '"SF"}' },
      { type: 'tool_call_delta', index: 1, id: 'toolu_2', name: 'get_time', argumentsDelta: '' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"tz":' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '"UTC"}' },
    ]);
  });

  it('drops an input_json_delta for a block that never started as tool_use', async () => {
    const sse = sseFrom([
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
      { type: 'content_block_stop', index: 0 },
      ...MESSAGE_END,
    ]);

    expect(await collectToolDeltas(sse)).toStrictEqual([]);
  });
});
