import { Injectable, Logger } from '@nestjs/common';
import type {
  ModelCapabilities,
  ProviderHealth,
  RoutingDecision,
} from '@sirius/core';
import { ProviderRegistry } from '@sirius/core';
import { ModelRegistryService } from '@sirius/model-registry';
import { LatencyTracker } from '@sirius/observability';
import type { RoutingCandidate, RoutingStrategy } from './strategies/routing-strategy.interface.js';
import { PinnedStrategy } from './strategies/pinned.strategy.js';
import { FastestStrategy } from './strategies/fastest.strategy.js';
import { CheapestStrategy } from './strategies/cheapest.strategy.js';
import { BalancedStrategy } from './strategies/balanced.strategy.js';
import { LocalFirstStrategy } from './strategies/local-first.strategy.js';
import { PrivacyFirstStrategy } from './strategies/privacy-first.strategy.js';

export interface RouteRequest {
  model: string;
  stream: boolean;
  tools?: unknown[];
  embeddings?: boolean;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly strategies = new Map<string, RoutingStrategy>();

  constructor(
    private readonly modelRegistry: ModelRegistryService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly latencyTracker: LatencyTracker,
    pinnedStrategy: PinnedStrategy,
    fastestStrategy: FastestStrategy,
    cheapestStrategy: CheapestStrategy,
    balancedStrategy: BalancedStrategy,
    localFirstStrategy: LocalFirstStrategy,
    privacyFirstStrategy: PrivacyFirstStrategy,
  ) {
    const all: RoutingStrategy[] = [
      pinnedStrategy,
      fastestStrategy,
      cheapestStrategy,
      balancedStrategy,
      localFirstStrategy,
      privacyFirstStrategy,
    ];

    for (const strategy of all) {
      this.strategies.set(strategy.name, strategy);
    }
  }

  /**
   * Main routing entry-point: resolve the model, collect candidates,
   * run the chosen strategy, and return a RoutingDecision.
   */
  route(request: RouteRequest, preferredStrategy?: string): RoutingDecision {
    const strategyName = preferredStrategy ?? this.getDefaultStrategy();

    // 1. Resolve the model from the registry.
    const resolved = this.modelRegistry.resolveModel(request.model);
    if (!resolved) {
      this.logger.warn(`Unknown model requested: ${request.model}`);
      return this.noRoute(
        request.model,
        strategyName,
        `The model '${request.model}' does not exist or you do not have access to it.`,
      );
    }

    // 2. Determine required capabilities from the request.
    const requiredCapabilities = this.deriveCapabilities(request);

    // 3. Get all providers and collect health information.
    const candidates = this.buildCandidates(
      resolved.modelId,
      requiredCapabilities,
    );

    if (candidates.length === 0) {
      const allProviders = this.modelRegistry.getProvidersForModel(
        resolved.modelId,
      );
      let reason = `No eligible candidates for model=${resolved.modelId}`;
      if (allProviders.length > 0) {
        reason = `The model '${resolved.modelId}' requires provider(s) '${allProviders.join(', ')}' which are not configured or are unhealthy.`;
      }

      this.logger.warn(
        `No eligible candidates for model=${resolved.modelId} capabilities=[${requiredCapabilities.join(', ')}]`,
      );
      return this.noRoute(resolved.modelId, strategyName, reason);
    }

    // 4. Pick strategy.
    const strategy = this.getStrategy(strategyName);

    const context = {
      requestedModel: resolved.modelId,
      requiredCapabilities,
      candidates,
    };

    // 5. Select primary and build fallback chain.
    const selected = strategy.select(context);
    const fallbackChain = strategy.buildFallbackChain(context);

    if (!selected) {
      return this.noRoute(resolved.modelId, strategyName);
    }

    return {
      selectedProvider: selected.model.provider,
      selectedModel: selected.model.modelId,
      strategy: strategy.name,
      reason: `Selected by ${strategy.name} strategy`,
      fallbackChain: fallbackChain.map(
        (c) => `${c.model.provider}/${c.model.modelId}`,
      ),
      attemptNumber: 1,
    };
  }

  /**
   * Retrieve a strategy by name.
   */
  getStrategy(name: string): RoutingStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      this.logger.warn(
        `Strategy "${name}" not found, falling back to pinned`,
      );
      return this.strategies.get('pinned')!;
    }
    return strategy;
  }

  /**
   * Return the default strategy name (could later be driven by config).
   */
  getDefaultStrategy(): string {
    return 'pinned';
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private deriveCapabilities(request: RouteRequest): string[] {
    const caps: string[] = [];

    if (request.embeddings) {
      caps.push('embeddings');
    } else {
      caps.push('chat');
    }

    if (request.stream) {
      caps.push('streaming');
    }

    if (request.tools && request.tools.length > 0) {
      caps.push('tools');
    }

    return caps;
  }

  private buildCandidates(
    modelId: string,
    requiredCapabilities: string[],
  ): RoutingCandidate[] {
    const candidates: RoutingCandidate[] = [];

    // Find all models in the registry with this modelId (could be served by multiple providers).
    const allModels = this.modelRegistry.listModels();
    const matchingModels = allModels.filter((m) => m.modelId === modelId);

    for (const model of matchingModels) {
      // Check that the provider is registered in the runtime provider registry.
      const provider = this.providerRegistry.get(model.provider);
      if (!provider) continue;

      // Check that the model meets all required capabilities.
      const meetsCaps = requiredCapabilities.every((cap) => {
        return model.capabilities[cap as keyof ModelCapabilities] === true;
      });
      if (!meetsCaps) continue;

      // Build a default health record — the routing service assumes healthy
      // if no health data is available yet.
      const avgLatency = this.latencyTracker.getAverageLatency(model.provider);
      const health: ProviderHealth = {
        provider: model.provider,
        status: 'healthy',
        latencyMs: avgLatency ?? 0,
        lastChecked: new Date(),
      };

      candidates.push({ model, health });
    }

    return candidates;
  }

  private noRoute(
    model: string,
    strategy: string,
    reason?: string,
  ): RoutingDecision {
    return {
      selectedProvider: '',
      selectedModel: model,
      strategy,
      reason: reason ?? 'No eligible provider found',
      fallbackChain: [],
      attemptNumber: 0,
    };
  }
}
