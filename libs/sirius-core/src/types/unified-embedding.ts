import type { UsageMetrics } from './unified-response.js';

export interface UnifiedEmbeddingRequest {
  requestId: string;
  model: string;
  input: string | string[];
  dimensions?: number;
  user?: string;
}

export interface UnifiedEmbeddingResponse {
  id: string;
  model: string;
  provider: string;
  embeddings: number[][];
  usage: UsageMetrics;
  latencyMs: number;
}
