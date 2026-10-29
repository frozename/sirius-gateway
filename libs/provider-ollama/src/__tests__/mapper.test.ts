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
import type { OllamaChatResponse } from '../ollama.types';
import type { UnifiedAiRequest } from '@sirius/core';

/** A final /api/chat message (done: true) with the given done_reason. */
function finalResponse(doneReason: string): OllamaChatResponse {
  return {
    model: 'llama3',
    created_at: '2024-01-01T00:00:00Z',
    message: { role: 'assistant', content: 'The quick brown' },
    done: true,
    done_reason: doneReason,
    prompt_eval_count: 5,
    eval_count: 3,
  };
}

/** #21: a user turn, one assistant tool call with the given arguments string, and its tool result. */
function toolCallHistory(toolArguments: string): UnifiedAiRequest {
  return makeUnifiedRequest({
    model: 'llama3',
    messages: [
      { role: 'user', content: 'weather in NY?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: toolArguments } },
        ],
      },
      { role: 'tool', content: '72F', toolCallId: 'c1' },
    ],
  });
}

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

    it('maps assistant toolCalls to tool_calls with parsed object arguments (#21)', () => {
      const ollama = toOllamaRequest(toolCallHistory('{"loc":"NY"}'));

      expect(ollama.messages).toHaveLength(3);
      expect(ollama.messages[1]).toEqual({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { loc: 'NY' } } }],
      });
      expect(ollama.messages[2]).toEqual({ role: 'tool', content: '72F' });
    });

    it('falls back to {} for empty, malformed or non-object arguments (#21)', () => {
      expect(() => toOllamaRequest(toolCallHistory('not json'))).not.toThrow();

      const fallbacks: string[] = ['not json', '', '[1,2]', '"text"', '42', 'null'];
      for (const raw of fallbacks) {
        const ollama = toOllamaRequest(toolCallHistory(raw));
        expect(ollama.messages[1]?.tool_calls).toEqual([
          { function: { name: 'get_weather', arguments: {} } },
        ]);
      }
    });

    it('maps every tool call of one assistant turn in order (#21)', () => {
      const ollama = toOllamaRequest(
        makeUnifiedRequest({
          messages: [
            {
              role: 'assistant',
              content: 'Checking both.',
              toolCalls: [
                { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"NY"}' } },
                { id: 'c2', type: 'function', function: { name: 'get_time', arguments: '{"tz":"EST","opts":{"h24":true}}' } },
              ],
            },
          ],
        }),
      );

      expect(ollama.messages[0]?.content).toBe('Checking both.');
      expect(ollama.messages[0]?.tool_calls).toEqual([
        { function: { name: 'get_weather', arguments: { loc: 'NY' } } },
        { function: { name: 'get_time', arguments: { tz: 'EST', opts: { h24: true } } } },
      ]);
    });

    it('adds no tool_calls key to messages without assistant tool calls (#21)', () => {
      const ollama = toOllamaRequest(
        makeUnifiedRequest({
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
            { role: 'assistant', content: '', toolCalls: [] },
            {
              role: 'user',
              content: 'odd',
              toolCalls: [{ id: 'c9', type: 'function', function: { name: 'noop', arguments: '{}' } }],
            },
          ],
        }),
      );

      expect(ollama.messages.map((m) => Object.keys(m))).toEqual([
        ['role', 'content'],
        ['role', 'content'],
        ['role', 'content'],
        ['role', 'content'],
      ]);
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

    // #14: done_reason on the final message decides between 'length' and 'stop'.
    it('maps done_reason length to finishReason length', () => {
      const unified = fromOllamaResponse(finalResponse('length'), 'ollama', 1);
      expect(unified.finishReason).toBe('length');
    });

    it('maps done_reason stop to finishReason stop', () => {
      const unified = fromOllamaResponse(finalResponse('stop'), 'ollama', 1);
      expect(unified.finishReason).toBe('stop');
    });

    it('maps an unknown done_reason (load) to finishReason stop', () => {
      const unified = fromOllamaResponse(finalResponse('load'), 'ollama', 1);
      expect(unified.finishReason).toBe('stop');
    });

    it('keeps tool_calls when tool calls come with done_reason stop', () => {
      const raw: OllamaChatResponse = {
        ...finalResponse('stop'),
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'get_weather', arguments: { loc: 'NY' } } }],
        },
      };
      const unified = fromOllamaResponse(raw, 'ollama', 1);
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
