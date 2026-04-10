import { describe, it, expect } from 'bun:test';
import { OpenAiCompatService } from '../openai-compat.service';
import type { UnifiedAiResponse, UnifiedStreamEvent } from '../../../sirius-core/src/index.js';

const service = new OpenAiCompatService();

describe('parseChatCompletionRequest', () => {
  it('parses a basic chat completion request', () => {
    const result = service.parseChatCompletionRequest(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      },
      'req-1',
    );

    expect(result.requestId).toBe('req-1');
    expect(result.model).toBe('gpt-4o');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[1]!.role).toBe('user');
    expect(result.stream).toBe(false);
  });

  it('maps streaming flag', () => {
    const result = service.parseChatCompletionRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true },
      'req-2',
    );

    expect(result.stream).toBe(true);
  });

  it('maps temperature and top_p', () => {
    const result = service.parseChatCompletionRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.5, top_p: 0.9 },
      'req-3',
    );

    expect(result.temperature).toBe(0.5);
    expect(result.topP).toBe(0.9);
  });

  it('prefers max_completion_tokens over max_tokens', () => {
    const result = service.parseChatCompletionRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 100, max_completion_tokens: 200 },
      'req-4',
    );

    expect(result.maxTokens).toBe(200);
  });

  it('maps tools', () => {
    const result = service.parseChatCompletionRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What weather?' }],
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
          },
        ],
      },
      'req-5',
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools![0]!.function.name).toBe('get_weather');
  });

  it('maps assistant messages with tool calls', () => {
    const result = service.parseChatCompletionRequest(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          { role: 'tool', content: '72F', tool_call_id: 'call_1' },
        ],
      },
      'req-6',
    );

    expect(result.messages[0]!.toolCalls).toHaveLength(1);
    expect(result.messages[0]!.toolCalls![0]!.id).toBe('call_1');
    expect(result.messages[1]!.role).toBe('tool');
    expect(result.messages[1]!.toolCallId).toBe('call_1');
  });

  it('normalizes stop as array', () => {
    const result = service.parseChatCompletionRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stop: 'END' },
      'req-7',
    );

    expect(result.stop).toEqual(['END']);
  });
});

describe('parseEmbeddingRequest', () => {
  it('parses a basic embedding request', () => {
    const result = service.parseEmbeddingRequest(
      { model: 'text-embedding-3-small', input: 'Hello world' },
      'req-emb-1',
    );

    expect(result.requestId).toBe('req-emb-1');
    expect(result.model).toBe('text-embedding-3-small');
    expect(result.input).toBe('Hello world');
  });

  it('passes dimensions when provided', () => {
    const result = service.parseEmbeddingRequest(
      { model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 256 },
      'req-emb-2',
    );

    expect(result.dimensions).toBe(256);
    expect(result.input).toEqual(['a', 'b']);
  });
});

describe('parseResponsesRequest', () => {
  it('wraps string input as user message', () => {
    const result = service.parseResponsesRequest(
      { model: 'gpt-4o', input: 'Hello' },
      'req-resp-1',
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toBe('Hello');
  });

  it('prepends instructions as system message', () => {
    const result = service.parseResponsesRequest(
      { model: 'gpt-4o', input: 'Hello', instructions: 'Be concise' },
      'req-resp-2',
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toBe('Be concise');
    expect(result.messages[1]!.role).toBe('user');
  });
});

describe('formatChatCompletionResponse', () => {
  it('formats a text response', () => {
    const unified: UnifiedAiResponse = {
      id: 'test-id',
      model: 'gpt-4o',
      provider: 'openai',
      content: [{ type: 'text', text: 'Hello world!' }],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      latencyMs: 100,
    };

    const result = service.formatChatCompletionResponse(unified);

    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-4o');
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0]!.message.content).toBe('Hello world!');
    expect(result.choices[0]!.message.role).toBe('assistant');
    expect(result.choices[0]!.finish_reason).toBe('stop');
    expect(result.usage!.prompt_tokens).toBe(10);
    expect(result.usage!.completion_tokens).toBe(5);
    expect(result.usage!.total_tokens).toBe(15);
    expect(result.id).toMatch(/^chatcmpl-/);
  });

  it('formats tool call response', () => {
    const unified: UnifiedAiResponse = {
      id: 'test-id',
      model: 'gpt-4o',
      provider: 'openai',
      content: [
        { type: 'tool_call', toolCall: { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } } },
      ],
      finishReason: 'tool_calls',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      latencyMs: 150,
    };

    const result = service.formatChatCompletionResponse(unified);

    expect(result.choices[0]!.finish_reason).toBe('tool_calls');
    expect(result.choices[0]!.message.tool_calls).toHaveLength(1);
    expect(result.choices[0]!.message.tool_calls![0]!.function.name).toBe('get_weather');
    expect(result.choices[0]!.message.content).toBeNull();
  });
});

describe('formatStreamChunk', () => {
  it('formats content_delta event', () => {
    const event: UnifiedStreamEvent = { type: 'content_delta', delta: 'Hello' };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-123', 'gpt-4o');

    expect(chunk).not.toBeNull();
    expect(chunk!.object).toBe('chat.completion.chunk');
    expect(chunk!.choices[0]!.delta.content).toBe('Hello');
    expect(chunk!.choices[0]!.finish_reason).toBeNull();
  });

  it('formats done event with finish_reason', () => {
    const event: UnifiedStreamEvent = { type: 'done', finishReason: 'stop' };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-123', 'gpt-4o');

    expect(chunk!.choices[0]!.finish_reason).toBe('stop');
  });

  it('formats usage event', () => {
    const event: UnifiedStreamEvent = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-123', 'gpt-4o');

    expect(chunk!.usage!.prompt_tokens).toBe(10);
    expect(chunk!.choices).toHaveLength(0);
  });

  it('returns null for error events', () => {
    const event: UnifiedStreamEvent = { type: 'error', error: 'something went wrong' };
    const chunk = service.formatStreamChunk(event, 'chatcmpl-123', 'gpt-4o');

    expect(chunk).toBeNull();
  });
});

describe('formatError', () => {
  it('formats a 401 error correctly', () => {
    const result = service.formatError(401, 'Unauthorized');

    expect(result.error.type).toBe('authentication_error');
    expect(result.error.message).toBe('Unauthorized');
    expect(result.error.param).toBeNull();
  });

  it('formats a 404 error correctly', () => {
    const result = service.formatError(404, 'Not found', 'not_found_error', 'model_not_found');

    expect(result.error.type).toBe('not_found_error');
    expect(result.error.code).toBe('model_not_found');
  });
});

describe('formatSSE', () => {
  it('formats data as SSE line', () => {
    const result = service.formatSSE({ hello: 'world' });
    expect(result).toBe('data: {"hello":"world"}\n\n');
  });

  it('formats done marker', () => {
    expect(service.formatSSEDone()).toBe('data: [DONE]\n\n');
  });
});

describe('formatModelList', () => {
  it('formats models as OpenAI list', () => {
    const result = service.formatModelList([
      { id: 'gpt-4o', provider: 'openai' },
      { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
    ]);

    expect(result.object).toBe('list');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.id).toBe('gpt-4o');
    expect(result.data[0]!.object).toBe('model');
    expect(result.data[0]!.owned_by).toBe('openai');
    expect(result.data[1]!.owned_by).toBe('anthropic');
  });
});
