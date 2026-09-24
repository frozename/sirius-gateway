import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  AiProvider,
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
  UnifiedStreamEvent,
  RoutingDecision,
  ModelInfo,
  ProviderHealth,
  UsageObservationCarrier,
} from '@sirius/core';
import { ProviderRegistry } from '@sirius/core';
import { RoutingService } from '@sirius/routing';
import { PolicyService } from '@sirius/policy';
import { StreamingObserver, LatencyTracker } from '@sirius/observability';

/**
 * A request may carry a caller AbortSignal (`request.signal`) when a
 * client-facing layer wants disconnects to cancel upstream work. It
 * is not part of the typed contract today, so it is read defensively.
 */
function callerSignal(
  request: UnifiedAiRequest | UnifiedEmbeddingRequest,
): AbortSignal | undefined {
  return (request as { signal?: AbortSignal }).signal;
}

export interface GatewayMeta {
  provider: string;
  model: string;
  strategy: string;
  tokensUsed?: number;
  providerLatencyMs?: number;
  fallbackUsed?: boolean;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly routingService: RoutingService,
    private readonly policyService: PolicyService,
    private readonly configService: ConfigService,
    private readonly streamingObserver: StreamingObserver,
    private readonly latencyTracker: LatencyTracker,
  ) {}

  async createResponse(request: UnifiedAiRequest): Promise<UnifiedAiResponse & { _gatewayMeta: GatewayMeta }> {
    const decision = this.routingService.route({
      model: request.model,
      stream: false,
      tools: request.tools,
    });

    if (!decision.selectedProvider) {
      throw new Error(decision.reason);
    }

    const providers = this.buildProviderChain(decision);
    let lastError: Error | undefined;

    for (let i = 0; i < providers.length; i++) {
      const { provider, modelId } = providers[i]!;
      try {
        const enrichedRequest = { ...request, model: modelId };
        const response = await this.policyService.executeWithPolicy(
          provider.name,
          (context) => provider.createResponse(enrichedRequest, context),
          callerSignal(request),
        );

        this.latencyTracker.record(provider.name, response.latencyMs);

        return {
          ...response,
          _gatewayMeta: {
            provider: provider.name,
            model: modelId,
            strategy: decision.strategy,
            tokensUsed: response.usage.totalTokens,
            providerLatencyMs: response.latencyMs,
            fallbackUsed: i > 0,
          },
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Provider ${provider.name} failed for model ${modelId}: ${lastError.message}`);
      }
    }

    const errorMessage = lastError
      ? `All providers failed. Last error: ${lastError.message}`
      : `All providers failed for model "${request.model}"`;
    throw new Error(errorMessage);
  }

  async *streamResponse(request: UnifiedAiRequest): AsyncIterable<UnifiedStreamEvent> {
    const idleTimeout = this.configService.get<number>('SIRIUS_STREAM_IDLE_TIMEOUT_MS', 30000);

    const decision = this.routingService.route({
      model: request.model,
      stream: true,
      tools: request.tools,
    });

    if (!decision.selectedProvider) {
      throw new Error(decision.reason);
    }

    const providers = this.buildProviderChain(decision);
    let lastError: Error | undefined;

    for (let i = 0; i < providers.length; i++) {
      const { provider, modelId } = providers[i]!;
      try {
        const enrichedRequest = { ...request, model: modelId };
        const start = Date.now();
        
        const rawStream = this.policyService.executeStreamWithPolicy(
          provider.name,
          () => provider.streamResponse(enrichedRequest),
        );

        const observedStream = this.streamingObserver.observe(
          rawStream,
          { requestId: request.requestId, model: modelId, provider: provider.name }
        );

        const iterator = observedStream[Symbol.asyncIterator]();

        try {
          while (true) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Stream idle timeout')),
                idleTimeout,
              );
            });

            const result = await Promise.race([
              iterator.next(),
              timeoutPromise,
            ]);
            clearTimeout(timer);

            if (result.done) {
              this.latencyTracker.record(provider.name, Date.now() - start);
              break;
            }
            yield result.value;
          }
          return;
        } finally {
          // Consumer break, idle timeout, or a mid-stream failure all
          // land here. Fire-and-forget: an upstream stuck at a pending
          // next() queues return() behind it, so awaiting it could
          // hang this generator.
          void iterator.return?.();
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Stream provider ${provider.name} failed: ${lastError.message}`);
      }
    }

    const errorMessage = lastError
      ? `All providers failed. Last error: ${lastError.message}`
      : `All providers failed for model "${request.model}"`;
    yield { type: 'error', error: errorMessage };
  }

  async createEmbeddings(
    request: UnifiedEmbeddingRequest,
  ): Promise<UnifiedEmbeddingResponse & UsageObservationCarrier> {
    const decision = this.routingService.route({
      model: request.model,
      stream: false,
      embeddings: true,
    });

    if (!decision.selectedProvider) {
      throw new Error(decision.reason);
    }

    const provider = this.providerRegistry.get(decision.selectedProvider);
    if (!provider) {
      throw new Error(`Provider "${decision.selectedProvider}" not registered`);
    }

    const response = await this.policyService.executeWithPolicy(
      provider.name,
      (context) => provider.createEmbeddings(request, context),
      callerSignal(request),
    );

    this.latencyTracker.record(provider.name, response.latencyMs);
    return response;
  }

  async listModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    const providers = this.providerRegistry.getAll();

    const results = await Promise.allSettled(
      providers.map((p) => p.listModels()),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allModels.push(...result.value);
      }
    }

    return allModels;
  }

  async getProviderHealth(): Promise<ProviderHealth[]> {
    const providers = this.providerRegistry.getAll();

    const results = await Promise.allSettled(
      providers.map((p) => p.healthCheck()),
    );

    return results.map((result, i) => {
      if (result.status === 'fulfilled') {
        const val = result.value;
        const avgLatency = this.latencyTracker.getAverageLatency(val.provider);
        return {
          ...val,
          latencyMs: avgLatency ?? val.latencyMs,
        };
      }
      return {
        provider: providers[i]!.name,
        status: 'down' as const,
        lastChecked: new Date(),
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }

  private buildProviderChain(decision: RoutingDecision): { provider: AiProvider; modelId: string }[] {
    const chain: { provider: AiProvider; modelId: string }[] = [];

    // Primary provider
    const primary = this.providerRegistry.get(decision.selectedProvider);
    if (primary) {
      chain.push({ provider: primary, modelId: decision.selectedModel });
    }

    // Fallback chain
    for (const fallback of decision.fallbackChain) {
      const [providerName, modelId] = fallback.split('/');
      if (!providerName || !modelId) continue;
      const provider = this.providerRegistry.get(providerName);
      if (provider && provider.name !== decision.selectedProvider) {
        chain.push({ provider, modelId });
      }
    }

    return chain;
  }
}
