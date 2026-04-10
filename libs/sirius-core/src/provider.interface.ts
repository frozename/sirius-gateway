import type { UnifiedAiRequest } from './types/unified-request.js';
import type { UnifiedAiResponse } from './types/unified-response.js';
import type { UnifiedStreamEvent } from './types/unified-stream.js';
import type {
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
} from './types/unified-embedding.js';
import type { ModelInfo } from './types/model-info.js';
import type { ProviderHealth } from './types/provider-health.js';

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiProvider {
  readonly name: string;
  createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse>;
  streamResponse(request: UnifiedAiRequest): AsyncIterable<UnifiedStreamEvent>;
  createEmbeddings(
    request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<ProviderHealth>;
}
