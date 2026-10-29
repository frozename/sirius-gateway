import { describe, it, expect } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { OpenAiCompatService } from '../openai-compat.service';
import type {
  OpenAiChatCompletionRequest,
  OpenAiEmbeddingRequest,
  OpenAiErrorResponse,
  OpenAiResponsesRequest,
} from '../types/index';
import type { UnifiedAiResponse, UnifiedStreamEvent } from '../../../sirius-core/src/index.js';

/**
 * Pins the request validation and response status mapping of
 * OpenAiCompatService that normalization.test.ts does not reach:
 * the 400 codes and their parameter bounds, response_format,
 * stream_options and content-part mapping, the Responses API status
 * for each finish reason, streamed tool-call deltas, and the
 * formatError status fallback. Ids are random, so only their prefix
 * is asserted, and the created timestamps are never asserted.
 */

const service = new OpenAiCompatService();

function catchHttpError(run: () => unknown): HttpException {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  return caught as HttpException;
}

function chatBody(extra: Partial<OpenAiChatCompletionRequest>): OpenAiChatCompletionRequest {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], ...extra };
}

function chatError(body: unknown): HttpException {
  return catchHttpError(() =>
    service.parseChatCompletionRequest(body as OpenAiChatCompletionRequest, 'req-v'),
  );
}

function invalidRequest(message: string, code: string | null): OpenAiErrorResponse {
  return { error: { message, type: 'invalid_request_error', param: null, code } };
}

function unifiedResponse(extra: Partial<UnifiedAiResponse>): UnifiedAiResponse {
  return {
    id: 'unified-1',
    model: 'gpt-4o',
    provider: 'openai',
    content: [{ type: 'text', text: 'Hello' }],
    finishReason: 'stop',
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    latencyMs: 5,
    ...extra,
  };
}

describe('parseChatCompletionRequest validation', () => {
  it('rejects a missing model with 400 model_required', () => {
    const error = chatError({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      invalidRequest("The 'model' field is required.", 'model_required'),
    );
  });

  it('rejects missing, non-array and empty messages with 400 messages_required', () => {
    const bodies: unknown[] = [
      { model: 'gpt-4o' },
      { model: 'gpt-4o', messages: 'Hi' },
      { model: 'gpt-4o', messages: [] },
    ];
    for (const body of bodies) {
      const error = chatError(body);
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual(
        invalidRequest(
          "The 'messages' field is required and must be a non-empty array.",
          'messages_required',
        ),
      );
    }
  });

  it('rejects temperature below 0 or above 2 with 400 invalid_temperature', () => {
    for (const temperature of [-0.1, 2.1]) {
      const error = chatError(chatBody({ temperature }));
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual(
        invalidRequest("The 'temperature' must be between 0 and 2.", 'invalid_temperature'),
      );
    }
  });

  it('accepts temperature at the bounds 0 and 2', () => {
    expect(service.parseChatCompletionRequest(chatBody({ temperature: 0 }), 'req-v').temperature).toBe(0);
    expect(service.parseChatCompletionRequest(chatBody({ temperature: 2 }), 'req-v').temperature).toBe(2);
  });

  it('rejects top_p below 0 or above 1 with 400 invalid_top_p', () => {
    for (const topP of [-0.01, 1.01]) {
      const error = chatError(chatBody({ top_p: topP }));
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual(
        invalidRequest("The 'top_p' must be between 0 and 1.", 'invalid_top_p'),
      );
    }
  });

  it('accepts top_p at the bounds 0 and 1', () => {
    expect(service.parseChatCompletionRequest(chatBody({ top_p: 0 }), 'req-v').topP).toBe(0);
    expect(service.parseChatCompletionRequest(chatBody({ top_p: 1 }), 'req-v').topP).toBe(1);
  });

  it('rejects n=2 with 400 unsupported_parameter', () => {
    const error = chatError(chatBody({ n: 2 }));
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      invalidRequest(
        'Multiple completions (n > 1) are not supported by this gateway.',
        'unsupported_parameter',
      ),
    );
  });

  it('accepts n=1', () => {
    const result = service.parseChatCompletionRequest(chatBody({ n: 1 }), 'req-v');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('rejects a message without role with a 400 and a null code', () => {
    const error = chatError({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }, { content: 'no role' }],
    });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(invalidRequest("Message at index 1 is missing 'role'.", null));
  });

  it('rejects a non-assistant message without content with a 400 and a null code', () => {
    const error = chatError({ model: 'gpt-4o', messages: [{ role: 'user' }] });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      invalidRequest("Message at index 0 is missing 'content'.", null),
    );
  });

  it('accepts an assistant message without content and maps it to empty content', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant' }] }),
      'req-v',
    );
    expect(result.messages[1]).toEqual({ role: 'assistant', content: '' });
  });
});

describe('parseChatCompletionRequest mapping', () => {
  it('maps a json_schema response_format to responseFormat.jsonSchema', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'reply', schema: { type: 'object' }, strict: true },
        },
      }),
      'req-v',
    );
    expect(result.responseFormat).toEqual({
      type: 'json_schema',
      jsonSchema: { name: 'reply', schema: { type: 'object' }, strict: true },
    });
  });

  it('maps a json_object response_format to its type only', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({ response_format: { type: 'json_object' } }),
      'req-v',
    );
    expect(result.responseFormat).toEqual({ type: 'json_object' });
  });

  it('maps stream_options.include_usage to streamOptions.includeUsage', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({ stream: true, stream_options: { include_usage: true } }),
      'req-v',
    );
    expect(result.streamOptions).toEqual({ includeUsage: true });
  });

  it('maps user text and image_url content parts', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look' },
              { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } },
            ],
          },
        ],
      }),
      'req-v',
    );
    expect(result.messages[0]!.content).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'image_url', imageUrl: 'https://example.test/a.png', detail: 'low' },
    ]);
  });

  it('maps a tool message to role tool with toolCallId', () => {
    const result = service.parseChatCompletionRequest(
      chatBody({
        messages: [
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
            ],
          },
          { role: 'tool', content: '18C', tool_call_id: 'call_1' },
        ],
      }),
      'req-v',
    );
    expect(result.messages[2]).toEqual({ role: 'tool', content: '18C', toolCallId: 'call_1' });
  });
});

describe('parseResponsesRequest and parseEmbeddingRequest', () => {
  it('maps the developer role to system and joins the text of array content parts', () => {
    const result = service.parseResponsesRequest(
      {
        model: 'gpt-4o',
        input: [
          { type: 'message', role: 'developer', content: 'Be brief.' },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'a' }, { type: 'input_image' }, { type: 'input_text', text: 'b' }],
          },
        ],
      },
      'req-r',
    );
    expect(result.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'ab' },
    ]);
  });

  it('maps max_output_tokens to maxTokens and passes metadata through', () => {
    const result = service.parseResponsesRequest(
      { model: 'gpt-4o', input: 'Hi', max_output_tokens: 64, metadata: { trace: 't-1' } },
      'req-r',
    );
    expect(result.maxTokens).toBe(64);
    expect(result.metadata).toEqual({ trace: 't-1' });
  });

  it('rejects a responses request without model with 400 model_required', () => {
    const error = catchHttpError(() =>
      service.parseResponsesRequest({ input: 'Hi' } as unknown as OpenAiResponsesRequest, 'req-r'),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      invalidRequest("The 'model' field is required.", 'model_required'),
    );
  });

  it('rejects a responses request with a missing or empty input with 400 input_required', () => {
    const bodies: unknown[] = [{ model: 'gpt-4o' }, { model: 'gpt-4o', input: '' }];
    for (const body of bodies) {
      const error = catchHttpError(() =>
        service.parseResponsesRequest(body as OpenAiResponsesRequest, 'req-r'),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual(
        invalidRequest("The 'input' field is required.", 'input_required'),
      );
    }
  });

  it('rejects an embedding request without input with 400 input_required', () => {
    const error = catchHttpError(() =>
      service.parseEmbeddingRequest(
        { model: 'text-embedding-3-small' } as unknown as OpenAiEmbeddingRequest,
        'req-e',
      ),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual(
      invalidRequest("The 'input' field is required.", 'input_required'),
    );
  });
});

describe('formatResponsesResponse', () => {
  it('reports status incomplete for finishReason length', () => {
    expect(service.formatResponsesResponse(unifiedResponse({ finishReason: 'length' })).status).toBe(
      'incomplete',
    );
  });

  it('reports status failed for finishReason error', () => {
    expect(service.formatResponsesResponse(unifiedResponse({ finishReason: 'error' })).status).toBe(
      'failed',
    );
  });

  it('reports status completed for finishReason stop and tool_calls', () => {
    expect(service.formatResponsesResponse(unifiedResponse({ finishReason: 'stop' })).status).toBe(
      'completed',
    );
    expect(
      service.formatResponsesResponse(unifiedResponse({ finishReason: 'tool_calls' })).status,
    ).toBe('completed');
  });

  it('puts one leading message item with the text parts before the function_call items', () => {
    const result = service.formatResponsesResponse(
      unifiedResponse({
        content: [
          { type: 'text', text: 'Hel' },
          {
            type: 'tool_call',
            toolCall: { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
          },
          { type: 'text', text: 'lo' },
        ],
        finishReason: 'tool_calls',
      }),
    );
    expect(result.output).toHaveLength(2);
    const [message, call] = result.output;
    expect(message?.type).toBe('message');
    expect(message?.id).toMatch(/^msg_/);
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'Hel' },
        { type: 'output_text', text: 'lo' },
      ],
    });
    expect(call?.type).toBe('function_call');
    expect(call?.id).toMatch(/^fc_/);
    expect(call).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"SF"}',
      status: 'completed',
    });
  });

  it('has no message item when the response has only a tool call', () => {
    const result = service.formatResponsesResponse(
      unifiedResponse({
        content: [
          { type: 'tool_call', toolCall: { id: 'call_2', type: 'function', function: { name: 'f', arguments: '{}' } } },
        ],
        finishReason: 'tool_calls',
      }),
    );
    expect(result.output.map((item) => item.type)).toEqual(['function_call']);
  });

  it('maps the response id prefix, model and usage', () => {
    const result = service.formatResponsesResponse(unifiedResponse({}));
    expect(result.id).toMatch(/^resp_/);
    expect(result.object).toBe('response');
    expect(result.model).toBe('gpt-4o');
    expect(result.usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
  });
});

describe('formatStreamChunk tool calls and finish reasons', () => {
  it('gives the first tool_call_delta an id, type function and the name', () => {
    const event: UnifiedStreamEvent = { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'f' };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-1', 'gpt-4o');
    expect(chunk!.choices[0]!.delta.tool_calls).toStrictEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'f' } },
    ]);
    expect(chunk!.choices[0]!.finish_reason).toBeNull();
  });

  it('sends only index and arguments on a continuation tool_call_delta', () => {
    const event: UnifiedStreamEvent = { type: 'tool_call_delta', index: 0, argumentsDelta: '{"a"' };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-1', 'gpt-4o');
    expect(chunk!.choices[0]!.delta.tool_calls).toStrictEqual([
      { index: 0, function: { arguments: '{"a"' } },
    ]);
  });

  it('keeps a known finish reason and falls back to stop for an unknown one', () => {
    const length: UnifiedStreamEvent = { type: 'done', finishReason: 'length' };
    const unknown: UnifiedStreamEvent = { type: 'done', finishReason: 'mystery' };
    expect(service.formatStreamChunk(length, 'chatcmpl-1', 'gpt-4o')!.choices[0]!.finish_reason).toBe('length');
    expect(service.formatStreamChunk(unknown, 'chatcmpl-1', 'gpt-4o')!.choices[0]!.finish_reason).toBe('stop');
  });

  it('formatFirstStreamChunk opens the stream with the assistant role', () => {
    const chunk = service.formatFirstStreamChunk('chatcmpl-1', 'gpt-4o');
    expect(chunk.id).toBe('chatcmpl-1');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.model).toBe('gpt-4o');
    expect(chunk.choices).toEqual([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  });
});

describe('formatError status fallback', () => {
  it('maps 403, 429 and 503 to their error types and an unmapped status to api_error', () => {
    expect(service.formatError(403, 'Forbidden').error.type).toBe('permission_error');
    expect(service.formatError(429, 'Slow down').error.type).toBe('rate_limit_error');
    expect(service.formatError(503, 'Down').error.type).toBe('service_unavailable_error');
    expect(service.formatError(418, 'Teapot')).toEqual({
      error: { message: 'Teapot', type: 'api_error', param: null, code: null },
    });
  });

  it('lets an explicit type and code override the status defaults', () => {
    expect(service.formatError(429, 'Busy', 'custom_error', 'custom_code')).toEqual({
      error: { message: 'Busy', type: 'custom_error', param: null, code: 'custom_code' },
    });
  });

  it('createHttpError carries the status and the formatted body', () => {
    const error = service.createHttpError(503, 'Down');
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      error: { message: 'Down', type: 'service_unavailable_error', param: null, code: null },
    });
  });
});
