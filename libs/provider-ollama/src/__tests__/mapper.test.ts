import { describe, it, expect } from 'bun:test';
import {
  toOllamaRequest,
  fromOllamaResponse,
  toOllamaEmbedRequest,
  fromOllamaEmbedResponse,
} from '../ollama.mapper';
import {
  makeUnifiedRequest,
  makeEmbeddingRequest,
} from '../../../../libs/sirius-core/src/__tests__/fixtures';

describe('OllamaMapper', () => {
  describe('toOllamaRequest', () => {
    it('maps generation options to num_predict etc', () => {
      const unified = makeUnifiedRequest({
        model: 'llama3',
        maxTokens: 500,
        temperature: 0.8,
      });

      const ollama = toOllamaRequest(unified);

      expect(ollama.model).toBe('llama3');
      expect(ollama.options?.num_predict).toBe(500);
      expect(ollama.options?.temperature).toBe(0.8);
    });

    it('extracts images from multi-part content', () => {
      const unified = makeUnifiedRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this' },
              { type: 'image_url', imageUrl: 'base64-data' },
            ],
          },
        ],
      });

      const ollama = toOllamaRequest(unified);
      const msg = ollama.messages[0]!;
      expect(msg.content).toBe('Analyze this');
      expect(msg.images).toEqual(['base64-data']);
    });
  });

  describe('fromOllamaResponse', () => {
    it('maps basic chat response', () => {
      const raw = {
        model: 'llama3',
        message: { role: 'assistant', content: 'Hi' },
        prompt_eval_count: 10,
        eval_count: 5,
        done: true,
      } as any;

      const unified = fromOllamaResponse(raw, 'ollama', 120);

      expect(unified.model).toBe('llama3');
      expect(unified.content).toEqual([{ type: 'text', text: 'Hi' }]);
      expect(unified.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });

    it('maps tool calls', () => {
      const raw = {
        model: 'llama3',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { loc: 'NY' } } }],
        },
        done: true,
      } as any;

      const unified = fromOllamaResponse(raw, 'ollama', 100);

      expect(unified.content).toHaveLength(1);
      expect(unified.content[0]!.type).toBe('tool_call');
      expect(unified.content[0]!.toolCall?.function.name).toBe('get_weather');
      expect(unified.content[0]!.toolCall?.function.arguments).toBe('{"loc":"NY"}');
      expect(unified.finishReason).toBe('tool_calls');
    });
  });

  describe('embeddings', () => {
    it('maps embedding request', () => {
      const unified = makeEmbeddingRequest({ input: ['a', 'b'] });
      const ollama = toOllamaEmbedRequest(unified);
      expect(ollama.input).toEqual(['a', 'b']);
    });

    it('maps embedding response', () => {
      const raw = {
        model: 'llama3',
        embeddings: [[0.1], [0.2]],
        prompt_eval_count: 4,
      } as any;

      const unified = fromOllamaEmbedResponse(raw, 'ollama', 40);
      expect(unified.embeddings).toEqual([[0.1], [0.2]]);
      expect(unified.usage.inputTokens).toBe(4);
    });
  });
});
;
