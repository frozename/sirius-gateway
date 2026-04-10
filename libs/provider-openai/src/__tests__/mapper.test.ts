import { describe, it, expect } from 'bun:test';
import {
  toOpenAiRequest,
  fromOpenAiResponse,
  toOpenAiEmbeddingRequest,
  fromOpenAiEmbeddingResponse,
} from '../openai.mapper';
import {
  makeUnifiedRequest,
  makeEmbeddingRequest,
} from '../../../../libs/sirius-core/src/__tests__/fixtures';

describe('OpenAiMapper', () => {
  describe('toOpenAiRequest', () => {
    it('maps basic request fields', () => {
      const unified = makeUnifiedRequest({
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 100,
        stop: ['\n'],
      });

      const openai = toOpenAiRequest(unified);

      expect(openai.model).toBe('gpt-4');
      expect(openai.temperature).toBe(0.7);
      expect(openai.max_tokens).toBe(100);
      expect(openai.stop).toEqual(['\n']);
    });

    it('maps messages with content parts', () => {
      const unified = makeUnifiedRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image_url', imageUrl: 'https://example.com/image.png' },
            ],
          },
        ],
      });

      const openai = toOpenAiRequest(unified);

      expect(openai.messages).toHaveLength(1);
      const msg = openai.messages[0]!;
      expect(Array.isArray(msg.content)).toBe(true);
      expect((msg.content as any)[0]).toEqual({ type: 'text', text: 'What is in this image?' });
      expect((msg.content as any)[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.png' },
      });
    });

    it('maps tools and tool choice', () => {
      const unified = makeUnifiedRequest({
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        toolChoice: 'auto',
      });

      const openai = toOpenAiRequest(unified);

      expect(openai.tools).toHaveLength(1);
      expect(openai.tools![0]!.function.name).toBe('get_weather');
      expect(openai.tool_choice).toBe('auto');
    });
  });

  describe('fromOpenAiResponse', () => {
    it('maps successful chat response', () => {
      const raw = {
        id: 'chat-123',
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as any;

      const unified = fromOpenAiResponse(raw, 'openai', 150);

      expect(unified.id).toBe('chat-123');
      expect(unified.content).toEqual([{ type: 'text', text: 'Hello!' }]);
      expect(unified.finishReason).toBe('stop');
      expect(unified.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      expect(unified.latencyMs).toBe(150);
    });

    it('maps tool call response', () => {
      const raw = {
        id: 'chat-123',
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      } as any;

      const unified = fromOpenAiResponse(raw, 'openai', 200);

      expect(unified.content).toHaveLength(1);
      expect(unified.content[0]).toEqual({
        type: 'tool_call',
        toolCall: {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{}' },
        },
      });
      expect(unified.finishReason).toBe('tool_calls');
    });
  });

  describe('embeddings', () => {
    it('maps embedding request', () => {
      const unified = makeEmbeddingRequest({ input: 'test', dimensions: 512 });
      const openai = toOpenAiEmbeddingRequest(unified);

      expect(openai.input).toBe('test');
      expect(openai.dimensions).toBe(512);
    });

    it('maps embedding response', () => {
      const raw = {
        model: 'text-embedding-3',
        data: [{ embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      } as any;

      const unified = fromOpenAiEmbeddingResponse(raw, 'openai', 50);

      expect(unified.embeddings).toEqual([[0.1, 0.2]]);
      expect(unified.usage.inputTokens).toBe(5);
    });
  });
});
