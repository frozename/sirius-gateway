import type {
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedContent,
  UnifiedFinishReason,
  UnifiedMessage,
} from '@sirius/core';

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolChoice,
} from './anthropic.types.js';

// ── Unified -> Anthropic ────────────────────────────────────────────

function toAnthropicContent(
  msg: UnifiedMessage,
): string | AnthropicContentBlock[] {
  // Tool role messages become user messages with tool_result blocks (handled separately)
  if (msg.role === 'tool') {
    return [
      {
        type: 'tool_result' as const,
        tool_use_id: msg.toolCallId ?? '',
        content: typeof msg.content === 'string' ? msg.content : '',
      },
    ];
  }

  // Assistant messages with tool calls
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    const blocks: AnthropicContentBlock[] = [];

    if (typeof msg.content === 'string' && msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }

    for (const tc of msg.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }

    return blocks;
  }

  if (typeof msg.content === 'string') return msg.content;

  // Multi-part content
  const blocks: AnthropicContentBlock[] = [];
  for (const part of msg.content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.imageUrl) {
      // Anthropic expects base64; pass through URL as-is in a text block for now
      blocks.push({ type: 'text', text: `[image: ${part.imageUrl}]` });
    }
  }
  return blocks.length === 1 && blocks[0]!.type === 'text'
    ? (blocks[0] as { type: 'text'; text: string }).text
    : blocks;
}

function mapToolChoice(
  choice: UnifiedAiRequest['toolChoice'],
): AnthropicToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === 'none') return undefined; // Anthropic has no "none"; simply omit tools
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function.name };
  }
  return undefined;
}

export function toAnthropicRequest(
  unified: UnifiedAiRequest,
): AnthropicRequest {
  // Separate system messages
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of unified.messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text ?? '')
              .join('\n');
      systemParts.push(text);
      continue;
    }

    // Anthropic only allows user/assistant roles
    const role: 'user' | 'assistant' =
      msg.role === 'assistant' ? 'assistant' : 'user';

    messages.push({
      role,
      content: toAnthropicContent(msg),
    });
  }

  const req: AnthropicRequest = {
    model: unified.model,
    max_tokens: unified.maxTokens ?? 4096,
    messages,
    stream: unified.stream,
  };

  if (systemParts.length > 0) {
    req.system = systemParts.join('\n\n');
  }

  if (unified.temperature !== undefined) req.temperature = unified.temperature;
  if (unified.topP !== undefined) req.top_p = unified.topP;
  if (unified.stop) req.stop_sequences = unified.stop;
  if (unified.user) req.metadata = { user_id: unified.user };

  if (unified.tools?.length) {
    req.tools = unified.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? {},
    }));
  }

  const toolChoice = mapToolChoice(unified.toolChoice);
  if (toolChoice) req.tool_choice = toolChoice;

  return req;
}

// ── Anthropic -> Unified ────────────────────────────────────────────

const STOP_REASON_MAP: Record<string, UnifiedFinishReason> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
};

export function mapStopReason(raw: string | null): UnifiedFinishReason {
  if (!raw) return 'stop';
  return STOP_REASON_MAP[raw] ?? 'stop';
}

export function fromAnthropicResponse(
  raw: AnthropicResponse,
  provider: string,
  latencyMs: number,
): UnifiedAiResponse {
  const content: UnifiedContent[] = [];

  for (const block of raw.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_call',
        toolCall: {
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        },
      });
    }
  }

  return {
    id: raw.id,
    model: raw.model,
    provider,
    content,
    finishReason: mapStopReason(raw.stop_reason),
    usage: {
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
      totalTokens:
        (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
    },
    latencyMs,
  };
}
