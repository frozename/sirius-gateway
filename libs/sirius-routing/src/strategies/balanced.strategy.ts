import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

/**
 * Balanced strategy: score = 0.5 * normalized_cost + 0.5 * normalized_latency.
 * Pick the candidate with the lowest composite score.
 */
@Injectable()
export class BalancedStrategy implements RoutingStrategy {
  readonly name = 'balanced';

  select(context: RoutingContext): RoutingCandidate | null {
    const scored = this.score(context.candidates);
    return scored[0]?.candidate ?? null;
  }

  buildFallbackChain(context: RoutingContext): RoutingCandidate[] {
    const scored = this.score(context.candidates);
    return scored.slice(1).map((s) => s.candidate);
  }

  private score(
    candidates: RoutingCandidate[],
  ): { candidate: RoutingCandidate; score: number }[] {
    const healthy = candidates.filter((c) => c.health.status !== 'down');
    if (healthy.length === 0) return [];

    // Gather raw values.
    const costs = healthy.map((c) => this.totalCost(c));
    const latencies = healthy.map((c) => c.health.latencyMs ?? Infinity);

    const maxCost = Math.max(...costs.filter((v) => v < Infinity), 1);
    const maxLatency = Math.max(...latencies.filter((v) => v < Infinity), 1);

    return healthy
      .map((candidate, i) => {
        const normCost = costs[i]! < Infinity ? costs[i]! / maxCost : 1;
        const normLatency =
          latencies[i]! < Infinity ? latencies[i]! / maxLatency : 1;
        return { candidate, score: 0.5 * normCost + 0.5 * normLatency };
      })
      .sort((a, b) => a.score - b.score);
  }

  private totalCost(candidate: RoutingCandidate): number {
    const input = candidate.model.costPer1kInput;
    const output = candidate.model.costPer1kOutput;
    if (input == null && output == null) return Infinity;
    return (input ?? 0) + (output ?? 0);
  }
}
