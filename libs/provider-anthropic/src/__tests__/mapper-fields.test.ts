import { describe, it, expect } from 'bun:test';
import {
  toAnthropicRequest,
  fromAnthropicResponse,
  mapStopReason,
} from '../anthropic.mapper';
import type { AnthropicResponse } from '../anthropic.types';
import { makeUnifiedRequest } from '../../../../libs/sirius-core/src/__tests__/fixtures';

/**
 * Pins anthropic.mapper rules that mapper.test.ts and adapter.test.ts leave
 * open: the stop-reason table, the max_tokens default, the optional sampling,
 * stop and user fields, joining of system text, the order of assistant text
 * and tool_use blocks, collapsing of single-part user content, tool
 * description and schema defaults, and zero usage when a response has none.
 */

function makeResponse(): AnthropicResponse {
  return {
    id: 'msg_pin_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'partial answer' }],
    model: 'claude-pin-model',
    stop_reason: 'max_tokens',
    usage: { input_tokens: 7, output_tokens: 3 },
  };
}

describe('anthropic.mapper stop reasons, request fields and content shapes', () => {
  describe('mapStopReason', () => {
    it('maps max_tokens to length', () => {
      expect(mapStopReason('max_tokens')).toBe('length');
    });

    it('maps tool_use to tool_calls', () => {
      expect(mapStopReason('tool_use')).toBe('tool_calls');
    });

    it('maps end_turn and stop_sequence to stop', () => {
      expect(mapStopReason('end_turn')).toBe('stop');
      expect(mapStopReason('stop_sequence')).toBe('stop');
    });

    it('maps null, an empty string and an unknown stop reason to stop', () => {
      expect(mapStopReason(null)).toBe('stop');
      expect(mapStopReason('')).toBe('stop');
      expect(mapStopReason('not_a_known_reason')).toBe('stop');
    });
  });

  describe('toAnthropicRequest fields', () => {
    it('builds only model, max_tokens 4096, messages and stream from a bare request', () => {
      const req = toAnthropicRequest(makeUnifiedRequest());
      expect(req.max_tokens).toBe(4096);
      expect(Object.keys(req).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
      expect(req.model).toBe('gpt-4o');
      expect(req.stream).toBe(false);
      expect(req.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('forwards maxTokens as max_tokens', () => {
      const req = toAnthropicRequest(makeUnifiedRequest({ maxTokens: 256 }));
      expect(req.max_tokens).toBe(256);
    });

    it('forwards temperature 0 instead of dropping it', () => {
      const req = toAnthropicRequest(makeUnifiedRequest({ temperature: 0 }));
      expect(req.temperature).toBe(0);
    });

    it('maps topP, stop and user to top_p, stop_sequences and metadata.user_id', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({ topP: 0.9, stop: ['END'], user: 'u1' }),
      );
      expect(req.top_p).toBe(0.9);
      expect(req.stop_sequences).toEqual(['END']);
      expect(req.metadata).toEqual({ user_id: 'u1' });
    });

    it('carries the tool description and maps missing parameters to an empty input_schema', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          tools: [{ type: 'function', function: { name: 'ping', description: 'Ping the host' } }],
        }),
      );
      expect(req.tools).toEqual([{ name: 'ping', description: 'Ping the host', input_schema: {} }]);
    });
  });

  describe('toAnthropicRequest system and message content', () => {
    it('joins system messages with a blank line and the text parts of an array system message with a newline', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          messages: [
            { role: 'system', content: 'A' },
            { role: 'user', content: 'Hi' },
            {
              role: 'system',
              content: [
                { type: 'text', text: 'x' },
                { type: 'image_url', imageUrl: 'http://img.test/a.png' },
                { type: 'text', text: 'y' },
              ],
            },
          ],
        }),
      );
      expect(req.system).toBe('A\n\nx\ny');
      expect(req.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    });

    it('puts assistant text before its tool_use blocks', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          messages: [
            { role: 'user', content: 'Weather?' },
            {
              role: 'assistant',
              content: 'Checking',
              toolCalls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"loc":"SF"}' },
                },
              ],
            },
          ],
        }),
      );
      expect(req.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { loc: 'SF' } },
        ],
      });
    });

    it('sends only tool_use blocks for empty assistant content and parses empty arguments as {}', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          messages: [
            { role: 'user', content: 'List files' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call_2', type: 'function', function: { name: 'list_files', arguments: '' } },
              ],
            },
          ],
        }),
      );
      expect(req.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_2', name: 'list_files', input: {} }],
      });
    });

    it('collapses a single text part of user content to a plain string', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'only part' }] }],
        }),
      );
      expect(req.messages[0]?.content).toBe('only part');
    });

    it('keeps two text parts as two text blocks and drops an empty text part', () => {
      const req = toAnthropicRequest(
        makeUnifiedRequest({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'one' },
                { type: 'text', text: '' },
                { type: 'text', text: 'two' },
              ],
            },
          ],
        }),
      );
      expect(req.messages[0]?.content).toEqual([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]);
    });
  });

  describe('fromAnthropicResponse', () => {
    it('maps stop_reason max_tokens to length and carries id, model, provider and latency', () => {
      const res = fromAnthropicResponse(makeResponse(), 'anthropic-pin', 42);
      expect(res.finishReason).toBe('length');
      expect(res.id).toBe('msg_pin_1');
      expect(res.model).toBe('claude-pin-model');
      expect(res.provider).toBe('anthropic-pin');
      expect(res.latencyMs).toBe(42);
      expect(res.content).toEqual([{ type: 'text', text: 'partial answer' }]);
      expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    });

    it('reports zero usage when the response has no usage object', () => {
      const raw = makeResponse();
      Reflect.deleteProperty(raw, 'usage');
      const res = fromAnthropicResponse(raw, 'anthropic-pin', 0);
      expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    });
  });
});
