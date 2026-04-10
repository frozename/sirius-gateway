import type {
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from '../types/index.js';
import type { UnifiedStreamEvent } from '../types/unified-stream.js';
import type { AiProvider } from '../provider.interface.js';
import type { ModelInfo } from '../types/model-info.js';
import type { ProviderHealth } from '../types/provider-health.js';

export function makeUnifiedRequest(
  overrides: Partial<UnifiedAiRequest> = {},
): UnifiedAiRequest {
  return {
    requestId: 'req-123',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  };
}

export function makeUnifiedResponse(
  overrides: Partial<UnifiedAiResponse> = {},
): UnifiedAiResponse {
  return {
    id: 'res-123',
    model: 'gpt-4o',
    provider: 'openai',
    content: [{ type: 'text', text: 'Hello there!' }],
    finishReason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    latencyMs: 100,
    ...overrides,
  };
}

export function makeEmbeddingRequest(
  overrides: Partial<UnifiedEmbeddingRequest> = {},
): UnifiedEmbeddingRequest {
  return {
    requestId: 'req-123',
    model: 'text-embedding-3-small',
    input: 'Hello world',
    ...overrides,
  };
}

export function makeEmbeddingResponse(
  overrides: Partial<UnifiedEmbeddingResponse> = {},
): UnifiedEmbeddingResponse {
  return {
    id: 'res-123',
    model: 'text-embedding-3-small',
    provider: 'openai',
    embeddings: [[0.1, 0.2, 0.3]],
    usage: {
      inputTokens: 2,
      outputTokens: 0,
      totalTokens: 2,
    },
    latencyMs: 50,
    ...overrides,
  };
}

export function makeStreamEvent(
  overrides: Partial<UnifiedStreamEvent> = {},
): UnifiedStreamEvent {
  if (overrides.type === 'content_delta') {
    return { type: 'content_delta', delta: 'hello', ...overrides };
  }
  if (overrides.type === 'tool_call_delta') {
    return {
      type: 'tool_call_delta',
      index: 0,
      id: 'call-123',
      name: 'get_weather',
      argumentsDelta: '{}',
      ...overrides,
    };
  }
  if (overrides.type === 'usage') {
    return {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ...overrides,
    };
  }
  if (overrides.type === 'done') {
    return { type: 'done', finishReason: 'stop', ...overrides };
  }
  if (overrides.type === 'error') {
    return { type: 'error', error: 'Something went wrong', ...overrides };
  }
  return { type: 'content_delta', delta: 'hello' };
}

export class MockProvider implements AiProvider {
  constructor(
    public readonly name: string = 'mock-provider',
    private responses: {
      response?: UnifiedAiResponse;
      stream?: UnifiedStreamEvent[];
      embeddings?: UnifiedEmbeddingResponse;
      error?: Error;
    } = {},
  ) {}

  setResponse(response: UnifiedAiResponse) {
    this.responses.response = response;
  }

  setStream(stream: UnifiedStreamEvent[]) {
    this.responses.stream = stream;
  }

  setEmbeddings(embeddings: UnifiedEmbeddingResponse) {
    this.responses.embeddings = embeddings;
  }

  setError(error: Error) {
    this.responses.error = error;
  }

  async createResponse(_request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
    if (this.responses.error) throw this.responses.error;
    return this.responses.response || makeUnifiedResponse({ provider: this.name });
  }

  async *streamResponse(
    _request: UnifiedAiRequest,
  ): AsyncIterable<UnifiedStreamEvent> {
    if (this.responses.error) throw this.responses.error;
    const stream = this.responses.stream || [
      makeStreamEvent({ type: 'content_delta', delta: 'Hello' }),
      makeStreamEvent({ type: 'done' }),
    ];
    for (const event of stream) {
      yield event;
    }
  }

  async createEmbeddings(
    _request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse> {
    if (this.responses.error) throw this.responses.error;
    return (
      this.responses.embeddings || makeEmbeddingResponse({ provider: this.name })
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'mock-model',
        name: 'Mock Model',
        provider: this.name,
        capabilities: {
          chat: true,
          embeddings: true,
          vision: false,
          toolUse: true,
        },
      } as any,
    ];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: 'healthy',
      latencyMs: 10,
      lastChecked: new Date(),
    };
  }
}

export const OPENAI_SSE_FIXTURE = 'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-3.5-turbo-0301","choices":[{"delta":{"content":"Hello"},"index":0,"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1677652288,"model":"gpt-3.5-turbo-0301","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]';

export const ANTHROPIC_SSE_FIXTURE = `event: message_start
data: {"type": "message_start", "message": {"id": "msg_123", "type": "message", "role": "assistant", "content": [], "model": "claude-3-opus-20240229", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 10, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 5}}

event: message_stop
data: {"type": "message_stop"}`;

export const OLLAMA_NDJSON_FIXTURE = `{"model":"llama2","created_at":"2023-08-04T19:22:45.499127Z","message":{"role":"assistant","content":"Hello"},"done":false}
{"model":"llama2","created_at":"2023-08-04T19:22:45.499127Z","done":true,"total_duration":48835834500,"load_duration":1334000,"prompt_eval_count":26,"prompt_eval_duration":342546000,"eval_count":282,"eval_duration":48482552000}`;
