import { describe, it, expect } from 'bun:test';
import type { RoutingCandidate, RoutingContext } from '../strategies/routing-strategy.interface';
import { PinnedStrategy } from '../strategies/pinned.strategy';
import type { ProviderStatus } from '../../../sirius-core/src/index.js';

/**
 * Pins the PinnedStrategy rules that routing.test.ts leaves open: only
 * 'down' candidates are removed ('degraded' stays selectable), a single
 * non-down candidate is returned whatever its modelId, the first exact
 * modelId match wins even when it is not listed first, a 'down' exact
 * match never wins, the first non-down candidate is the fallback when
 * nothing matches, and the fallback chain is always empty. Every case
 * uses requestedModel 'requested-model' (see contextOf).
 */

type CandidateSpec = {
  costInput?: number;
  costOutput?: number;
  latencyMs?: number;
  status?: ProviderStatus;
};

function makeCandidate(provider: string, modelId: string, spec: CandidateSpec): RoutingCandidate {
  return {
    model: {
      modelId,
      provider,
      aliases: [],
      capabilities: { chat: true, streaming: true, tools: true, embeddings: false, vision: false, jsonMode: false },
      contextWindow: 128000,
      maxOutputTokens: 16384,
      costPer1kInput: spec.costInput,
      costPer1kOutput: spec.costOutput,
    },
    health: {
      provider,
      status: spec.status ?? 'healthy',
      latencyMs: spec.latencyMs,
      lastChecked: new Date(0),
    },
  };
}

function contextOf(candidates: RoutingCandidate[]): RoutingContext {
  return { requestedModel: 'requested-model', requiredCapabilities: ['chat'], candidates };
}

describe('PinnedStrategy health filter, exact match and fallback chain', () => {
  const strategy = new PinnedStrategy();

  it('is named pinned', () => {
    expect(strategy.name).toBe('pinned');
  });

  it('returns the only non-down candidate even when its modelId differs from the requested model', () => {
    const context = contextOf([
      makeCandidate('openai', 'down-a', { status: 'down' }),
      makeCandidate('anthropic', 'only-up', {}),
      makeCandidate('groq', 'down-b', { status: 'down' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('only-up');
  });

  it('selects a degraded candidate when every other candidate is down', () => {
    const context = contextOf([
      makeCandidate('openai', 'requested-model', { status: 'down' }),
      makeCandidate('anthropic', 'degraded-model', { status: 'degraded' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('degraded-model');
  });

  it('prefers a degraded exact match over a healthy candidate listed first', () => {
    const context = contextOf([
      makeCandidate('openai', 'healthy-other', {}),
      makeCandidate('anthropic', 'requested-model', { status: 'degraded' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('requested-model');
  });

  it('selects the first exact modelId match even when it is not first in the list', () => {
    const context = contextOf([
      makeCandidate('groq', 'other-a', {}),
      makeCandidate('openai', 'requested-model', {}),
      makeCandidate('anthropic', 'requested-model', {}),
    ]);
    const selected = strategy.select(context);
    expect(selected?.model.modelId).toBe('requested-model');
    expect(selected?.model.provider).toBe('openai');
  });

  it('falls back to the first non-down candidate in input order when none matches exactly', () => {
    const context = contextOf([
      makeCandidate('openai', 'down-first', { status: 'down' }),
      makeCandidate('anthropic', 'first-up', {}),
      makeCandidate('groq', 'second-up', { status: 'degraded' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('first-up');
  });

  it('never selects a down candidate whose modelId matches exactly', () => {
    const context = contextOf([
      makeCandidate('openai', 'requested-model', { status: 'down' }),
      makeCandidate('anthropic', 'up-a', {}),
      makeCandidate('groq', 'up-b', {}),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('up-a');
  });

  it('returns null when every candidate is down', () => {
    const context = contextOf([
      makeCandidate('openai', 'requested-model', { status: 'down' }),
      makeCandidate('anthropic', 'other-down', { status: 'down' }),
    ]);
    expect(strategy.select(context)).toBeNull();
  });

  it('returns an empty fallback chain when several candidates are selectable', () => {
    const context = contextOf([
      makeCandidate('openai', 'up-a', {}),
      makeCandidate('anthropic', 'requested-model', {}),
      makeCandidate('groq', 'up-c', { status: 'degraded' }),
    ]);
    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });
});
