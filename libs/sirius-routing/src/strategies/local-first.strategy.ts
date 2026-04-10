import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

const LOCAL_PROVIDERS = new Set(['ollama']);

/**
 * Local-first strategy: prefer local providers (e.g. Ollama), then sort
 * remaining candidates by latency. The fallback chain places local providers
 * first, followed by cloud providers in latency order.
 */
@Injectable()
export class LocalFirstStrategy implements RoutingStrategy {
  readonly name = 'local-first';

  select(context: RoutingContext): RoutingCandidate | null {
    const sorted = this.rank(context.candidates);
    return sorted[0] ?? null;
  }

  buildFallbackChain(context: RoutingContext): RoutingCandidate[] {
    const sorted = this.rank(context.candidates);
    return sorted.slice(1);
  }

  private rank(candidates: RoutingCandidate[]): RoutingCandidate[] {
    const healthy = candidates.filter((c) => c.health.status !== 'down');

    const local = healthy
      .filter((c) => LOCAL_PROVIDERS.has(c.model.provider))
      .sort(
        (a, b) =>
          (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity),
      );

    const cloud = healthy
      .filter((c) => !LOCAL_PROVIDERS.has(c.model.provider))
      .sort(
        (a, b) =>
          (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity),
      );

    return [...local, ...cloud];
  }
}
