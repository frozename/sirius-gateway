import type { UnifiedStreamEvent } from '@sirius/core';
import type { OpenAiChatChunk } from './openai.types.js';
import { mapFinishReason } from './openai.mapper.js';

/**
 * Parse an OpenAI SSE stream into a sequence of UnifiedStreamEvents.
 *
 * OpenAI streams use the standard SSE format:
 *   data: {"id":"...","choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *   ...
 *   data: [DONE]
 */
export async function* parseOpenAiStream(
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        yield* processLine(line);
      }
    }

    if (buffer.trim()) {
      yield* processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function* processLine(line: string): Iterable<UnifiedStreamEvent> {
  const trimmed = line.trim();

  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith(':')) return;

  // Only process data lines
  if (!trimmed.startsWith('data: ')) return;

  const data = trimmed.slice(6); // Remove "data: " prefix

  // End-of-stream sentinel
  if (data === '[DONE]') {
    return;
  }

  let chunk: OpenAiChatChunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return; // Skip malformed JSON
  }

  const choice = chunk.choices[0];
  if (!choice) return;

  const { delta, finish_reason } = choice;

  // Content delta
  if (delta.content) {
    yield { type: 'content_delta', delta: delta.content };
  }

  // Tool call deltas
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      yield {
        type: 'tool_call_delta',
        index: tc.index ?? 0,
        id: tc.id,
        name: tc.function?.name,
        argumentsDelta: tc.function?.arguments,
      };
    }
  }

  // Usage information (some models include it in the final chunk)
  if (chunk.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      },
    };
  }

  // Finish reason
  if (finish_reason) {
    yield {
      type: 'done',
      finishReason: mapFinishReason(finish_reason),
    };
  }
}
