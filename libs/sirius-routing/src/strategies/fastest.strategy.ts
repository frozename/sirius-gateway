import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

/**
 * Fastest strategy: sort candidates by reported latency (ascending)
 * and pick the fastest healthy one.
 */
@Injectable()
export class FastestStrategy implements RoutingStrategy {
  readonly name = 'fastest';

  select(context: RoutingContext): RoutingCandidate | null {
    const sorted = this.sortByLatency(context.candidates);
    return sorted[0] ?? null;
  }

  buildFallbackChain(context: RoutingContext): RoutingCandidate[] {
    const sorted = this.sortByLatency(context.candidates);
    // Exclude the primary selection (index 0).
    return sorted.slice(1);
  }

  private sortByLatency(candidates: RoutingCandidate[]): RoutingCandidate[] {
    return [...candidates]
      .filter((c) => c.health.status !== 'down')
      .sort((a, b) => (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity));
  }
}
