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
  fromOllamaEmbedResponse,
  fromOllamaResponse,
  toOllamaEmbedRequest,
  toOllamaRequest,
} from './ollama.mapper.js';
import { parseOllamaStream } from './ollama.stream-parser.js';
import type {
  OllamaChatResponse,
  OllamaEmbedResponse,
  OllamaTagsResponse,
} from './ollama.types.js';

@Injectable()
export class OllamaAdapter implements AiProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaAdapter.name);

  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
  ) {}

  /** Ollama requires no authentication — always considered configured. */
  isConfigured(): boolean {
    return true;
  }

  // ── Chat completion (non-streaming) ─────────────────────────────

  async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse> {
    const ollamaRequest = toOllamaRequest({ ...request, stream: false });
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(ollamaRequest),
    });

    if (!res.ok) {
      const error = await res
        .text()
        .catch(() => res.statusText);
      throw new Error(`Ollama API error ${res.status}: ${error}`);
    }

    const raw = (await res.json()) as OllamaChatResponse;
    return fromOllamaResponse(raw, this.name, Date.now() - start);
  }

  // ── Chat completion (streaming) ─────────────────────────────────

  async *streamResponse(
    request: UnifiedAiRequest,
  ): AsyncIterable<UnifiedStreamEvent> {
    const ollamaRequest = toOllamaRequest({ ...request, stream: true });

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(ollamaRequest),
    });

    if (!res.ok) {
      const error = await res
        .text()
        .catch(() => res.statusText);
      yield {
        type: 'error',
        error: `Ollama API error ${res.status}: ${error}`,
      };
      return;
    }

    yield* parseOllamaStream(res);
  }

  // ── Embeddings ──────────────────────────────────────────────────

  async createEmbeddings(
    request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse> {
    const embedRequest = toOllamaEmbedRequest(request);
    const start = Date.now();

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(embedRequest),
    });

    if (!res.ok) {
      const error = await res
        .text()
        .catch(() => res.statusText);
      throw new Error(`Ollama Embed API error ${res.status}: ${error}`);
    }

    const raw = (await res.json()) as OllamaEmbedResponse;
    return fromOllamaEmbedResponse(raw, this.name, Date.now() - start);
  }

  // ── Models ──────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) {
      const error = await res
        .text()
        .catch(() => res.statusText);
      throw new Error(`Ollama Tags API error ${res.status}: ${error}`);
    }

    const raw = (await res.json()) as OllamaTagsResponse;
    return raw.models.map((m) => ({
      id: m.name,
      provider: this.name,
      ownedBy: 'local',
    }));
  }

  // ── Health ──────────────────────────────────────────────────────

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/`, {
        method: 'GET',
      });

      if (res.ok) {
        return {
          provider: this.name,
          status: 'healthy',
          latencyMs: Date.now() - start,
          lastChecked: new Date(),
        };
      }

      return {
        provider: this.name,
        status: 'down',
        latencyMs: Date.now() - start,
        lastChecked: new Date(),
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    } catch (err) {
      this.logger.error('Ollama health-check failed', err);
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
      'Content-Type': 'application/json',
    };
  }
}
