import type { UnifiedStreamEvent } from '@sirius/core';
import type { AnthropicStreamEvent } from './anthropic.types.js';
import { mapStopReason } from './anthropic.mapper.js';

/**
 * Per-stream usage state (#32). message_delta usage may omit
 * input_tokens, so the message_start input count is kept here and
 * reused for the final usage event.
 */
interface StreamUsageState {
  inputTokens: number | undefined;
}

/**
 * Parse an Anthropic SSE stream into a sequence of UnifiedStreamEvents.
 *
 * Anthropic uses named SSE events:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 */
export async function* parseAnthropicStream(
  response: Response,
): AsyncIterable<UnifiedStreamEvent> {
  const body = response.body;
  if (!body) {
    yield { type: 'error', error: 'Response body is null' };
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Anthropic content-block index -> OpenAI-style tool ordinal (0, 1, ...).
  // Text blocks share the content-block numbering, so the block index
  // cannot be used as the tool_calls index (#9).
  const toolOrdinals = new Map<number, number>();
  const usageState: StreamUsageState = { inputTokens: undefined };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        yield* processLine(line, toolOrdinals, usageState);
      }
    }

    if (buffer.trim()) {
      yield* processLine(buffer, toolOrdinals, usageState);
    }
  } finally {
    reader.releaseLock();
  }
}

function* processLine(
  line: string,
  toolOrdinals: Map<number, number>,
  usageState: StreamUsageState,
): Iterable<UnifiedStreamEvent> {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith(':')) return;

  // We only care about data lines; the event name is encoded in the
  // JSON payload's "type" field.
  if (!trimmed.startsWith('data: ')) return;

  const data = trimmed.slice(6);

  let event: AnthropicStreamEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  switch (event.type) {
    case 'message_start': {
      // Could emit usage for input tokens from message_start
      const usage = event.message?.usage;
      if (usage) {
        usageState.inputTokens = usage.input_tokens;
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          },
        };
      }
      break;
    }

    case 'content_block_start': {
      const block = event.content_block;
      if (block.type === 'tool_use') {
        const ordinal = toolOrdinals.size;
        toolOrdinals.set(event.index, ordinal);
        // The first fragment of a tool call is the only one that carries
        // its id and name, as in OpenAI's streaming format.
        yield {
          type: 'tool_call_delta',
          index: ordinal,
          id: block.id,
          name: block.name,
          argumentsDelta: '',
        };
      }
      break;
    }

    case 'content_block_delta': {
      if (event.delta.type === 'text_delta') {
        yield { type: 'content_delta', delta: event.delta.text };
      } else if (event.delta.type === 'input_json_delta') {
        const ordinal = toolOrdinals.get(event.index);
        // A fragment for a block that never started as tool_use has no
        // tool call to attach to.
        if (ordinal !== undefined) {
          yield {
            type: 'tool_call_delta',
            index: ordinal,
            argumentsDelta: event.delta.partial_json,
          };
        }
      }
      break;
    }

    case 'content_block_stop':
      // No action needed; block finished.
      break;

    case 'message_delta': {
      // Usage update + stop reason. The counts are cumulative; when
      // input_tokens is absent, reuse the message_start count (#32).
      if (event.usage) {
        const inputTokens = event.usage.input_tokens ?? usageState.inputTokens ?? 0;
        const outputTokens = event.usage.output_tokens;
        yield {
          type: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
        };
      }
      if (event.delta?.stop_reason) {
        yield {
          type: 'done',
          finishReason: mapStopReason(event.delta.stop_reason),
        };
      }
      break;
    }

    case 'message_stop':
      // Stream finished.
      break;
  }
}
