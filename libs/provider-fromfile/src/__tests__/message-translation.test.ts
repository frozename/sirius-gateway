import { describe, expect, test } from 'bun:test';
import { nova } from '@sirius/core';
import type { UnifiedAiRequest, UnifiedStreamEvent } from '@sirius/core';
import { toSiriusAdapter } from '../fromfile-provider.module.js';

/**
 * #37: the from-file shim must hand content-part arrays, tool fields and
 * sampling params to the nova core on both the non-stream and the stream
 * path. A fake core records every request it receives; no network is
 * involved.
 */

const novaResponse: nova.UnifiedAiResponse = {
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  model: 'm',
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const chunkEvent: nova.UnifiedStreamEvent = {
  type: 'chunk',
  chunk: {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    model: 'm',
    created: 1,
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
  },
};

const doneEvent: nova.UnifiedStreamEvent = {
  type: 'done',
  finish_reason: 'stop',
  completion: 'upstream',
};

function makeRecordingCore(): { core: nova.AiProvider; requests: nova.UnifiedAiRequest[] } {
  const requests: nova.UnifiedAiRequest[] = [];
  const core: nova.AiProvider = {
    name: 'recording-core',
    async createResponse(
      request: nova.UnifiedAiRequest,
      _context?: nova.ProviderExecutionContext,
    ): Promise<nova.UnifiedAiResponse> {
      requests.push(request);
      return novaResponse;
    },
    async *streamResponse(
      request: nova.UnifiedAiRequest,
      _signal?: AbortSignal,
    ): AsyncIterable<nova.UnifiedStreamEvent> {
      requests.push(request);
      yield chunkEvent;
      yield doneEvent;
    },
  };
  return { core, requests };
}

const textPartReq: UnifiedAiRequest = {
  requestId: 'req-parts',
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
  stream: false,
};

describe('toSiriusAdapter request translation (#37)', () => {
  test('createResponse forwards text-part array content as nova text blocks', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);

    await adapter.createResponse(textPartReq);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'What is 2+2?' }]);
  });

  test('createResponse forwards image_url parts with url and optional detail', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);
    const req: UnifiedAiRequest = {
      requestId: 'req-image',
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe both' },
            { type: 'image_url', imageUrl: 'https://example.test/a.png', detail: 'low' },
            { type: 'image_url', imageUrl: 'https://example.test/b.png' },
          ],
        },
      ],
      stream: false,
    };

    await adapter.createResponse(req);

    expect(requests[0]?.messages[0]?.content).toStrictEqual([
      { type: 'text', text: 'Describe both' },
      { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } },
      { type: 'image_url', image_url: { url: 'https://example.test/b.png' } },
    ]);
  });

  test('string content and a bare request pass through unchanged', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);
    const req: UnifiedAiRequest = {
      requestId: 'req-string',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    };

    await adapter.createResponse(req);

    expect(requests[0]).toStrictEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  test('createResponse forwards name, tool_call_id and tool_calls', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);
    const req: UnifiedAiRequest = {
      requestId: 'req-tools',
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: 'tool', content: '42', name: 'lookup', toolCallId: 'call_1' },
      ],
      stream: false,
    };

    await adapter.createResponse(req);

    expect(requests[0]?.messages).toStrictEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: 'tool', content: '42', name: 'lookup', tool_call_id: 'call_1' },
    ]);
  });

  test('createResponse forwards temperature, top_p and max_tokens', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);
    const req: UnifiedAiRequest = {
      requestId: 'req-sampling',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 16,
    };

    await adapter.createResponse(req);

    expect(requests[0]).toStrictEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16,
    });
  });

  test('streamResponse forwards sampling params and array content', async () => {
    const { core, requests } = makeRecordingCore();
    const adapter = toSiriusAdapter('fake', core);
    const req: UnifiedAiRequest = {
      ...textPartReq,
      requestId: 'req-stream',
      stream: true,
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 16,
    };

    const events: UnifiedStreamEvent[] = [];
    for await (const event of adapter.streamResponse(req)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'content_delta', delta: 'ok' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toStrictEqual({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }],
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16,
    });
  });
});
