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
  fromOpenAiEmbeddingResponse,
  fromOpenAiResponse,
  toOpenAiEmbeddingRequest,
  toOpenAiRequest,
} from './openai.mapper.js';
import { parseOpenAiStream } from './openai.stream-parser.js';
import type {
  OpenAiChatResponse,
  OpenAiEmbeddingResponse,
  OpenAiModelList,
} from './openai.types.js';

@Injectable()
export class OpenAiAdapter implements AiProvider {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiAdapter.name);

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.openai.com',
  ) {}

  /** Returns true if an API key has been configured. */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  // ── Chat completion (non-streaming) ─────────────────────────────

  async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
    const openAiRequest = toOpenAiRequest({ ...request, stream: false });
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(openAiRequest),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      throw new Error(
        `OpenAI API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      );
    }

    const raw = (await res.json()) as OpenAiChatResponse;
    return fromOpenAiResponse(raw, this.name, Date.now() - start);
  }

  // ── Chat completion (streaming) ─────────────────────────────────

  async *streamResponse(
    request: UnifiedAiRequest,
  ): AsyncIterable<UnifiedStreamEvent> {
    const openAiRequest = toOpenAiRequest({ ...request, stream: true });

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(openAiRequest),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      yield {
        type: 'error',
        error: `OpenAI API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      };
      return;
    }

    yield* parseOpenAiStream(res);
  }

  // ── Embeddings ──────────────────────────────────────────────────

  async createEmbeddings(
    request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse> {
    const embeddingRequest = toOpenAiEmbeddingRequest(request);
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(embeddingRequest),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      throw new Error(
        `OpenAI Embeddings API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      );
    }

    const raw = (await res.json()) as OpenAiEmbeddingResponse;
    return fromOpenAiEmbeddingResponse(raw, this.name, Date.now() - start);
  }

  // ── Models ──────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ error: { message: res.statusText } }));
      throw new Error(
        `OpenAI Models API error ${res.status}: ${(error as Record<string, Record<string, string>>)?.error?.message ?? res.statusText}`,
      );
    }

    const raw = (await res.json()) as OpenAiModelList;
    return raw.data.map((m) => ({
      id: m.id,
      provider: this.name,
      created: m.created,
      ownedBy: m.owned_by,
    }));
  }

  // ── Health ──────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      await this.listModels();
      return {
        provider: this.name,
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
      };
    } catch (err) {
      this.logger.error('OpenAI health-check failed', err);
      return {
        provider: this.name,
        status: 'down',
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
