import type { ModelCapabilityMatrix, ProviderHealth } from '@sirius/core';

export interface RoutingCandidate {
  model: ModelCapabilityMatrix;
  health: ProviderHealth;
}

export interface RoutingContext {
  requestedModel: string;
  requiredCapabilities: string[]; // e.g., ['chat', 'streaming', 'tools']
  candidates: RoutingCandidate[];
}

export interface RoutingStrategy {
  readonly name: string;
  select(context: RoutingContext): RoutingCandidate | null;
  buildFallbackChain(context: RoutingContext): RoutingCandidate[];
}
