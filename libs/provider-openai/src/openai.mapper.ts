import type {
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedContent,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
  UnifiedFinishReason,
  UnifiedMessage,
  UnifiedContentPart,
} from '@sirius/core';

import type {
  OpenAiChatRequest,
  OpenAiChatResponse,
  OpenAiContentPart,
  OpenAiEmbeddingRequest,
  OpenAiEmbeddingResponse,
  OpenAiMessage,
} from './openai.types.js';

// ── Unified -> OpenAI ───────────────────────────────────────────────

function mapContentPart(part: UnifiedContentPart): OpenAiContentPart {
  if (part.type === 'image_url') {
    return { type: 'image_url', image_url: { url: part.imageUrl ?? '' } };
  }
  return { type: 'text', text: part.text ?? '' };
}

function mapMessage(msg: UnifiedMessage): OpenAiMessage {
  const base: OpenAiMessage = {
    role: msg.role,
    content:
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.map(mapContentPart),
  };

  if (msg.name) base.name = msg.name;
  if (msg.toolCallId) base.tool_call_id = msg.toolCallId;
  if (msg.toolCalls) base.tool_calls = msg.toolCalls;

  return base;
}

export function toOpenAiRequest(unified: UnifiedAiRequest): OpenAiChatRequest {
  const req: OpenAiChatRequest = {
    model: unified.model,
    messages: unified.messages.map(mapMessage),
    stream: unified.stream,
  };

  if (unified.temperature !== undefined) req.temperature = unified.temperature;
  if (unified.topP !== undefined) req.top_p = unified.topP;
  if (unified.maxTokens !== undefined) req.max_tokens = unified.maxTokens;
  if (unified.stop) req.stop = unified.stop;
  if (unified.user) req.user = unified.user;

  if (unified.tools?.length) {
    req.tools = unified.tools.map((t) => ({
      type: t.type,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: t.function.strict,
      },
    }));
  }

  if (unified.toolChoice !== undefined) {
    req.tool_choice = unified.toolChoice;
  }

  if (unified.streamOptions) {
    req.stream_options = {
      include_usage: unified.streamOptions.includeUsage,
    };
  }

  if (unified.responseFormat) {
    req.response_format = {
      type: unified.responseFormat.type,
    };
    if (unified.responseFormat.jsonSchema) {
      req.response_format.json_schema = {
        name: unified.responseFormat.jsonSchema.name,
        schema: unified.responseFormat.jsonSchema.schema,
        strict: unified.responseFormat.jsonSchema.strict,
      };
    }
  }

  return req;
}

// ── OpenAI -> Unified ───────────────────────────────────────────────

const FINISH_REASON_MAP: Record<string, UnifiedFinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
};

export function mapFinishReason(raw: string | null): UnifiedFinishReason {
  if (!raw) return 'stop';
  return FINISH_REASON_MAP[raw] ?? 'stop';
}

export function fromOpenAiResponse(
  raw: OpenAiChatResponse,
  provider: string,
  latencyMs: number,
): UnifiedAiResponse {
  const choice = raw.choices[0];
  const content: UnifiedContent[] = [];

  if (choice?.message.content) {
    const text =
      typeof choice.message.content === 'string'
        ? choice.message.content
        : choice.message.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('');
    if (text) {
      content.push({ type: 'text', text });
    }
  }

  if (choice?.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_call',
        toolCall: {
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
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
    finishReason: mapFinishReason(choice?.finish_reason ?? null),
    usage: {
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      totalTokens: raw.usage?.total_tokens ?? 0,
    },
    latencyMs,
  };
}

// ── Embeddings ──────────────────────────────────────────────────────

export function toOpenAiEmbeddingRequest(
  unified: UnifiedEmbeddingRequest,
): OpenAiEmbeddingRequest {
  const req: OpenAiEmbeddingRequest = {
    model: unified.model,
    input: unified.input,
  };
  if (unified.dimensions !== undefined) req.dimensions = unified.dimensions;
  if (unified.user) req.user = unified.user;
  return req;
}

export function fromOpenAiEmbeddingResponse(
  raw: OpenAiEmbeddingResponse,
  provider: string,
  latencyMs: number,
): UnifiedEmbeddingResponse {
  return {
    id: `emb-${Date.now()}`,
    model: raw.model,
    provider,
    embeddings: raw.data.map((d) => d.embedding),
    usage: {
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      totalTokens: raw.usage?.total_tokens ?? raw.usage?.prompt_tokens ?? 0,
    },
    latencyMs,
  };
}
