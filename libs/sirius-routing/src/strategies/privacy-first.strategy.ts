import { Injectable } from '@nestjs/common';
import type {
  RoutingCandidate,
  RoutingContext,
  RoutingStrategy,
} from './routing-strategy.interface.js';

const LOCAL_PROVIDERS = new Set(['ollama']);

/**
 * Privacy-first strategy: ONLY return local providers. Cloud providers are
 * used as a last resort — only when no local provider is available at all.
 */
@Injectable()
export class PrivacyFirstStrategy implements RoutingStrategy {
  readonly name = 'privacy-first';

  select(context: RoutingContext): RoutingCandidate | null {
    const ranked = this.rank(context.candidates);
    return ranked[0] ?? null;
  }

  buildFallbackChain(context: RoutingContext): RoutingCandidate[] {
    const ranked = this.rank(context.candidates);
    return ranked.slice(1);
  }

  private rank(candidates: RoutingCandidate[]): RoutingCandidate[] {
    const healthy = candidates.filter((c) => c.health.status !== 'down');

    const local = healthy
      .filter((c) => LOCAL_PROVIDERS.has(c.model.provider))
      .sort(
        (a, b) =>
          (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity),
      );

    // Only fall back to cloud when there are zero local candidates.
    if (local.length > 0) {
      return local;
    }

    return healthy.sort(
      (a, b) =>
        (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity),
    );
  }
}
