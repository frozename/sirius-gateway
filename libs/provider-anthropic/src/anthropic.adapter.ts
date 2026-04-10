import { Injectable, Logger } from '@nestjs/common';
import type {
  AiProvider,
  ModelInfo,
  ProviderHealth,
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
  UnifiedStreamEvent,
} from '@sirius/core';

import {
  fromAnthropicResponse,
  toAnthropicRequest,
} from './anthropic.mapper.js';
import { parseAnthropicStream } from './anthropic.stream-parser.js';
import type { AnthropicResponse } from './anthropic.types.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

/** Well-known Anthropic models (the API does not expose a list endpoint). */
const KNOWN_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
  { id: 'claude-opus-4-20250514', provider: 'anthropic' },
  { id: 'claude-3-7-sonnet-20250219', provider: 'anthropic' },
  { id: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
  { id: 'claude-3-5-haiku-20241022', provider: 'anthropic' },
  { id: 'claude-3-opus-20240229', provider: 'anthropic' },
  { id: 'claude-3-haiku-20240307', provider: 'anthropic' },
];

@Injectable()
export class AnthropicAdapter implements AiProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicAdapter.name);

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.anthropic.com',
  ) {}

  /** Returns true if an API key has been configured. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  // ── Chat completion (non-streaming) ─────────────────────────────

  async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
    const anthropicRequest = toAnthropicRequest({ ...request, stream: false });
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(anthropicRequest),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      throw new Error(
        `Anthropic API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      );
    }

    const raw = (await res.json()) as AnthropicResponse;
    return fromAnthropicResponse(raw, this.name, Date.now() - start);
  }

  // ── Chat completion (streaming) ─────────────────────────────────

  async *streamResponse(
    request: UnifiedAiRequest,
  ): AsyncIterable<UnifiedStreamEvent> {
    const anthropicRequest = toAnthropicRequest({ ...request, stream: true });

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(anthropicRequest),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      yield {
        type: 'error',
        error: `Anthropic API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      };
      return;
    }

    yield* parseAnthropicStream(res);
  }

  // ── Embeddings ──────────────────────────────────────────────────

  async createEmbeddings(
    _request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse> {
    throw new Error(
      'Anthropic does not support embeddings. Use a different provider.',
    );
  }

  // ── Models ──────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    return KNOWN_MODELS;
  }

  // ── Health ──────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: 'down',
        lastChecked: new Date(),
        error: 'API key not configured',
      };
    }

    // Anthropic does not have a lightweight health / ping endpoint,
    // so we simply report healthy if the key is present.
    return {
      provider: this.name,
      status: 'healthy',
      lastChecked: new Date(),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'Content-Type': 'application/json',
    };
  }
}
