import { describe, it, expect } from 'bun:test';
import type { RoutingCandidate, RoutingContext } from '../strategies/routing-strategy.interface';
import { BalancedStrategy } from '../strategies/balanced.strategy';
import type { ProviderStatus } from '../../../sirius-core/src/index.js';

/**
 * Pins BalancedStrategy: 'down' candidates are dropped, the score is
 * 0.5 * cost / maxCost + 0.5 * latency / maxLatency (both maxima floored
 * at 1, unknown cost or latency scoring 1), ties keep input order, and
 * the fallback chain is the scored list minus the selected candidate.
 */

type CandidateSpec = {
  costInput?: number;
  costOutput?: number;
  latencyMs?: number;
  status?: ProviderStatus;
};

function makeCandidate(provider: string, spec: CandidateSpec): RoutingCandidate {
  return {
    model: {
      modelId: 'shared-model',
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
  return { requestedModel: 'shared-model', requiredCapabilities: ['chat'], candidates };
}

function providers(candidates: RoutingCandidate[]): string[] {
  return candidates.map((c) => c.model.provider);
}

describe('BalancedStrategy', () => {
  const strategy = new BalancedStrategy();

  it('is named balanced', () => {
    expect(strategy.name).toBe('balanced');
  });

  it('returns null and an empty chain for no candidates', () => {
    const context = contextOf([]);
    expect(strategy.select(context)).toBeNull();
    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });

  it('returns null and an empty chain when every candidate is down', () => {
    const context = contextOf([
      makeCandidate('a', { costInput: 0.01, costOutput: 0.03, latencyMs: 100, status: 'down' }),
      makeCandidate('b', { costInput: 0.01, costOutput: 0.03, latencyMs: 50, status: 'down' }),
    ]);
    expect(strategy.select(context)).toBeNull();
    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });

  it('never selects or chains a down candidate but keeps a degraded one', () => {
    const context = contextOf([
      makeCandidate('a', { costInput: 0.01, costOutput: 0.01, latencyMs: 10, status: 'down' }),
      makeCandidate('b', { costInput: 0.02, costOutput: 0.02, latencyMs: 50, status: 'degraded' }),
      makeCandidate('c', { costInput: 0.02, costOutput: 0.02, latencyMs: 100 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('b');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['c']);
  });

  it('weighs normalised cost and latency equally', () => {
    // x: 0.5*4/4 + 0.5*40/100 = 0.7; y: 0.5*2/4 + 0.5*100/100 = 0.75;
    // z: 0.5*3/4 + 0.5*60/100 = 0.675. Fastest is x, cheapest is y.
    const context = contextOf([
      makeCandidate('x', { costInput: 2, costOutput: 2, latencyMs: 40 }),
      makeCandidate('y', { costInput: 1, costOutput: 1, latencyMs: 100 }),
      makeCandidate('z', { costInput: 1.5, costOutput: 1.5, latencyMs: 60 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('z');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['x', 'y']);
  });

  it('floors maxCost at 1, so sub-1 per-1k costs are not rescaled and latency dominates', () => {
    // cheap: 0.5*0.02 + 0.5*100/100 = 0.51; fast: 0.5*0.08 + 0.5*60/100 = 0.34.
    const context = contextOf([
      makeCandidate('cheap', { costInput: 0.01, costOutput: 0.01, latencyMs: 100 }),
      makeCandidate('fast', { costInput: 0.04, costOutput: 0.04, latencyMs: 60 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('fast');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['cheap']);
  });

  it('ranks zero-cost candidates by latency', () => {
    const context = contextOf([
      makeCandidate('slow', { costInput: 0, costOutput: 0, latencyMs: 100 }),
      makeCandidate('quick', { costInput: 0, costOutput: 0, latencyMs: 50 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('quick');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['slow']);
  });

  it('ranks zero-latency candidates by cost', () => {
    const context = contextOf([
      makeCandidate('dear', { costInput: 0.15, costOutput: 0.15, latencyMs: 0 }),
      makeCandidate('thrifty', { costInput: 0.05, costOutput: 0.05, latencyMs: 0 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('thrifty');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['dear']);
  });

  it('scores an unknown cost as the maximum normalised cost', () => {
    // unpriced: 0.5*1 + 0.5*50/50 = 1; priced: 0.5*0.4 + 0.5*50/50 = 0.7.
    const context = contextOf([
      makeCandidate('unpriced', { latencyMs: 50 }),
      makeCandidate('priced', { costInput: 0.2, costOutput: 0.2, latencyMs: 50 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('priced');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['unpriced']);
  });

  it('scores an unknown latency as the maximum normalised latency', () => {
    // m: 0.5*0.4 + 0.5*40/80 = 0.45; unmeasured: 0.5*0.4 + 0.5*1 = 0.7;
    // n: 0.5*0.8 + 0.5*80/80 = 0.9.
    const context = contextOf([
      makeCandidate('unmeasured', { costInput: 0.2, costOutput: 0.2 }),
      makeCandidate('m', { costInput: 0.2, costOutput: 0.2, latencyMs: 40 }),
      makeCandidate('n', { costInput: 0.4, costOutput: 0.4, latencyMs: 80 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('m');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['unmeasured', 'n']);
  });

  it('counts a missing input or output cost as 0 when the other is set', () => {
    // q: 0.5*0.4 + 0.5*50/50 = 0.7; inputOnly: 0.5*0.3 + 0.5 = 0.65;
    // outputOnly: 0.5*0.35 + 0.5 = 0.675.
    const context = contextOf([
      makeCandidate('q', { costInput: 0.2, costOutput: 0.2, latencyMs: 50 }),
      makeCandidate('inputOnly', { costInput: 0.3, latencyMs: 50 }),
      makeCandidate('outputOnly', { costOutput: 0.35, latencyMs: 50 }),
    ]);
    expect(strategy.select(context)?.model.provider).toBe('inputOnly');
    expect(providers(strategy.buildFallbackChain(context))).toEqual(['outputOnly', 'q']);
  });

  it('keeps input order for equal scores', () => {
    const same: CandidateSpec = { costInput: 0.01, costOutput: 0.03, latencyMs: 100 };
    const forward = contextOf([makeCandidate('a', same), makeCandidate('b', same), makeCandidate('c', same)]);
    expect(strategy.select(forward)?.model.provider).toBe('a');
    expect(providers(strategy.buildFallbackChain(forward))).toEqual(['b', 'c']);
    const reversed = contextOf([makeCandidate('c', same), makeCandidate('b', same), makeCandidate('a', same)]);
    expect(strategy.select(reversed)?.model.provider).toBe('c');
    expect(providers(strategy.buildFallbackChain(reversed))).toEqual(['b', 'a']);
  });

  it('builds the fallback chain as the scored list minus the selected candidate', () => {
    const x = makeCandidate('x', { costInput: 2, costOutput: 2, latencyMs: 40 });
    const y = makeCandidate('y', { costInput: 1, costOutput: 1, latencyMs: 100 });
    const z = makeCandidate('z', { costInput: 1.5, costOutput: 1.5, latencyMs: 60 });
    const context = contextOf([x, y, z]);
    const selected = strategy.select(context);
    const chain = strategy.buildFallbackChain(context);
    expect(selected).toBe(z);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(x);
    expect(chain[1]).toBe(y);
    expect(chain).not.toContain(z);
  });

  it('selects a lone healthy candidate with an empty chain', () => {
    const only = makeCandidate('only', { costInput: 0.01, costOutput: 0.03, latencyMs: 100 });
    const context = contextOf([only]);
    expect(strategy.select(context)).toBe(only);
    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });
});
