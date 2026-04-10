import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

/**
 * Cheapest strategy: sort candidates by total cost (costPer1kInput + costPer1kOutput)
 * ascending. Models without cost data are pushed to the end.
 */
@Injectable()
export class CheapestStrategy implements RoutingStrategy {
  readonly name = 'cheapest';

  select(context: RoutingContext): RoutingCandidate | null {
    const sorted = this.sortByCost(context.candidates);
    return sorted[0] ?? null;
  }

  buildFallbackChain(context: RoutingContext): RoutingCandidate[] {
    const sorted = this.sortByCost(context.candidates);
    return sorted.slice(1);
  }

  private sortByCost(candidates: RoutingCandidate[]): RoutingCandidate[] {
    return [...candidates]
      .filter((c) => c.health.status !== 'down')
      .sort((a, b) => this.totalCost(a) - this.totalCost(b));
  }

  private totalCost(candidate: RoutingCandidate): number {
    const input = candidate.model.costPer1kInput;
    const output = candidate.model.costPer1kOutput;

    // Models without cost data sort to the end.
    if (input == null && output == null) return Infinity;

    return (input ?? 0) + (output ?? 0);
  }
}
