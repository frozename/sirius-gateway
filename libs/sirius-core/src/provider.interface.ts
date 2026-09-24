import type {
  ProviderExecutionContext,
  UsageObservationV1,
} from '@nova/contracts';
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

/**
 * Optional carrier for a provenance-tagged usage observation captured
 * from the upstream (nova `onUsageObservation`). Adapters that can
 * obtain one attach it under `metadata.usageObservation`; the usage
 * recorder projects it onto the V1 sink only when the counts were
 * fully observed, so absent stays absent — never a fabricated zero.
 */
export interface UsageObservationCarrier {
  metadata?: { usageObservation?: UsageObservationV1 };
}

export interface AiProvider {
  readonly name: string;
  createResponse(
    request: UnifiedAiRequest,
    context?: ProviderExecutionContext,
  ): Promise<UnifiedAiResponse>;
  streamResponse(request: UnifiedAiRequest): AsyncIterable<UnifiedStreamEvent>;
  createEmbeddings(
    request: UnifiedEmbeddingRequest,
    context?: ProviderExecutionContext,
  ): Promise<UnifiedEmbeddingResponse & UsageObservationCarrier>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<ProviderHealth>;
}
