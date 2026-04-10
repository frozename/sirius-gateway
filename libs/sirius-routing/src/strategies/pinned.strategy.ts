import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

/**
 * Pinned strategy: if the requested model maps to exactly one provider,
 * select it directly. No fallback chain is provided.
 */
@Injectable()
export class PinnedStrategy implements RoutingStrategy {
  readonly name = 'pinned';

  select(context: RoutingContext): RoutingCandidate | null {
    const healthy = context.candidates.filter(
      (c) => c.health.status !== 'down',
    );

    if (healthy.length === 1) {
      return healthy[0]!;
    }

    // If there are multiple healthy candidates, pick the first whose model
    // id exactly matches the requested model.
    const exact = healthy.find(
      (c) => c.model.modelId === context.requestedModel,
    );
    return exact ?? healthy[0] ?? null;
  }

  buildFallbackChain(_context: RoutingContext): RoutingCandidate[] {
    // Pinned strategy does not provide fallbacks.
    return [];
  }
}
