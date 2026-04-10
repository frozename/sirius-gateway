import type {
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedContent,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
  UnifiedFinishReason,
  UnifiedMessage,
} from '@sirius/core';

import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaEmbedRequest,
  OllamaEmbedResponse,
  OllamaMessage,
} from './ollama.types.js';

// ── Unified -> Ollama ───────────────────────────────────────────────

function mapMessage(msg: UnifiedMessage): OllamaMessage {
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('');

  const result: OllamaMessage = {
    role: msg.role,
    content,
  };

  // Pass images if present in multi-part content
  if (typeof msg.content !== 'string') {
    const images = msg.content
      .filter((p) => p.type === 'image_url' && p.imageUrl)
      .map((p) => p.imageUrl!);
    if (images.length > 0) result.images = images;
  }

  return result;
}

export function toOllamaRequest(unified: UnifiedAiRequest): OllamaChatRequest {
  const req: OllamaChatRequest = {
    model: unified.model,
    messages: unified.messages.map(mapMessage),
    stream: unified.stream,
  };

  // Map generation options
  const options: OllamaChatRequest['options'] = {};
  if (unified.temperature !== undefined) options.temperature = unified.temperature;
  if (unified.topP !== undefined) options.top_p = unified.topP;
  if (unified.maxTokens !== undefined) options.num_predict = unified.maxTokens;
  if (unified.stop) options.stop = unified.stop;

  if (Object.keys(options).length > 0) req.options = options;

  if (unified.tools?.length) {
    req.tools = unified.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? {},
      },
    }));
  }

  return req;
}

// ── Ollama -> Unified ───────────────────────────────────────────────

export function fromOllamaResponse(
  raw: OllamaChatResponse,
  provider: string,
  latencyMs: number,
): UnifiedAiResponse {
  const content: UnifiedContent[] = [];

  if (raw.message.content) {
    content.push({ type: 'text', text: raw.message.content });
  }

  if (raw.message.tool_calls) {
    for (const tc of raw.message.tool_calls) {
      content.push({
        type: 'tool_call',
        toolCall: {
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        },
      });
    }
  }

  const finishReason: UnifiedFinishReason =
    raw.message.tool_calls?.length ? 'tool_calls' : 'stop';

  return {
    id: `ollama-${Date.now()}`,
    model: raw.model,
    provider,
    content,
    finishReason,
    usage: {
      inputTokens: raw.prompt_eval_count ?? 0,
      outputTokens: raw.eval_count ?? 0,
      totalTokens: (raw.prompt_eval_count ?? 0) + (raw.eval_count ?? 0),
    },
    latencyMs,
  };
}

// ── Embeddings ──────────────────────────────────────────────────────

export function toOllamaEmbedRequest(
  unified: UnifiedEmbeddingRequest,
): OllamaEmbedRequest {
  return {
    model: unified.model,
    input: unified.input,
  };
}

export function fromOllamaEmbedResponse(
  raw: OllamaEmbedResponse,
  provider: string,
  latencyMs: number,
): UnifiedEmbeddingResponse {
  return {
    id: `ollama-emb-${Date.now()}`,
    model: raw.model,
    provider,
    embeddings: raw.embeddings,
    usage: {
      inputTokens: raw.prompt_eval_count ?? 0,
      outputTokens: 0,
      totalTokens: raw.prompt_eval_count ?? 0,
    },
    latencyMs,
  };
}
