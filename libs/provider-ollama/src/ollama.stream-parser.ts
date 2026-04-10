import type { UnifiedStreamEvent } from '@sirius/core';
import type { OllamaChatChunk } from './ollama.types.js';

/**
 * Parse an Ollama NDJSON stream into a sequence of UnifiedStreamEvents.
 *
 * Ollama uses newline-delimited JSON (not SSE):
 *   {"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":false}
 *   {"model":"llama3","message":{"role":"assistant","content":"!"},"done":false}
 *   {"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":25}
 */
export async function* parseOllamaStream(
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
  let seenToolCalls = false;
  const toolCallIds = new Map<number, string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const events = processLine(line, seenToolCalls, toolCallIds);
        for (const event of events) {
          if (event.type === 'tool_call_delta') seenToolCalls = true;
          yield event;
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      const events = processLine(buffer, seenToolCalls, toolCallIds);
      for (const event of events) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* processLine(
  line: string,
  seenToolCalls: boolean,
  toolCallIds: Map<number, string>,
): Iterable<UnifiedStreamEvent> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let chunk: OllamaChatChunk;
  try {
    chunk = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Content delta
  if (chunk.message?.content) {
    yield { type: 'content_delta', delta: chunk.message.content };
  }

  // Tool call deltas
  if (chunk.message?.tool_calls) {
    for (let i = 0; i < chunk.message.tool_calls.length; i++) {
      const tc = chunk.message.tool_calls[i]!;

      let id = toolCallIds.get(i);
      if (!id) {
        id = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        toolCallIds.set(i, id);
      }

      yield {
        type: 'tool_call_delta',
        index: i,
        id,
        name: tc.function.name,
        argumentsDelta: JSON.stringify(tc.function.arguments),
      };
    }
  }

  // Final chunk with done=true contains usage info
  if (chunk.done) {
    if (
      chunk.prompt_eval_count !== undefined ||
      chunk.eval_count !== undefined
    ) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
          totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
        },
      };
    }

    const finishReason =
      seenToolCalls || chunk.message?.tool_calls?.length ? 'tool_calls' : 'stop';
    yield { type: 'done', finishReason };
  }
}
