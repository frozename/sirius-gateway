import { describe, it, expect } from 'bun:test';
import {
  toAnthropicRequest,
  fromAnthropicResponse,
} from '../anthropic.mapper';
import { makeUnifiedRequest } from '../../../../libs/sirius-core/src/__tests__/fixtures';

describe('AnthropicMapper', () => {
  describe('toAnthropicRequest', () => {
    it('extracts system message to top-level field', () => {
      const unified = makeUnifiedRequest({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      const anthropic = toAnthropicRequest(unified);

      expect(anthropic.system).toBe('You are a helpful assistant.');
      expect(anthropic.messages).toHaveLength(1);
      expect(anthropic.messages[0]!.role).toBe('user');
    });

    it('maps tool result messages correctly', () => {
      const unified = makeUnifiedRequest({
        messages: [
          { role: 'user', content: 'What is the weather?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"loc":"SF"}' } },
            ],
          },
          { role: 'tool', toolCallId: 'call_1', content: 'Sunny, 75F' },
        ],
      });

      const anthropic = toAnthropicRequest(unified);

      expect(anthropic.messages).toHaveLength(3);
      const toolResult = anthropic.messages[2]!;
      expect(toolResult.role).toBe('user');
      expect(Array.isArray(toolResult.content)).toBe(true);
      expect((toolResult.content as any)[0].type).toBe('tool_result');
      expect((toolResult.content as any)[0].tool_use_id).toBe('call_1');
      expect((toolResult.content as any)[0].content).toBe('Sunny, 75F');
    });

    it('maps tool choice', () => {
      const unified = makeUnifiedRequest({
        tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
        toolChoice: 'required',
      });

      const anthropic = toAnthropicRequest(unified);
      expect(anthropic.tool_choice).toEqual({ type: 'any' });

      const unified2 = makeUnifiedRequest({
        tools: [{ type: 'function', function: { name: 'test', parameters: {} } }],
        toolChoice: { type: 'function', function: { name: 'test' } },
      });
      const anthropic2 = toAnthropicRequest(unified2);
      expect(anthropic2.tool_choice).toEqual({ type: 'tool', name: 'test' });
    });
  });

  describe('fromAnthropicResponse', () => {
    it('maps successful response', () => {
      const raw = {
        id: 'msg_1',
        model: 'claude-3',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      } as any;

      const unified = fromAnthropicResponse(raw, 'anthropic', 100);

      expect(unified.content).toEqual([{ type: 'text', text: 'Hello!' }]);
      expect(unified.finishReason).toBe('stop');
      expect(unified.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    });

    it('maps tool use response', () => {
      const raw = {
        id: 'msg_1',
        model: 'claude-3',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { loc: 'SF' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 15 },
      } as any;

      const unified = fromAnthropicResponse(raw, 'anthropic', 150);

      expect(unified.content).toHaveLength(2);
      expect(unified.content[1]).toEqual({
        type: 'tool_call',
        toolCall: {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"loc":"SF"}' },
        },
      });
      expect(unified.finishReason).toBe('tool_calls');
    });
  });
});
