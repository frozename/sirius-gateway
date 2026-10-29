import { describe, it, expect } from 'bun:test';
import type { RoutingCandidate, RoutingContext } from '../strategies/routing-strategy.interface';
import { CheapestStrategy } from '../strategies/cheapest.strategy';
import { FastestStrategy } from '../strategies/fastest.strategy';
import { LocalFirstStrategy } from '../strategies/local-first.strategy';
import { PrivacyFirstStrategy } from '../strategies/privacy-first.strategy';
import type { ProviderStatus } from '../../../sirius-core/src/index.js';

/**
 * Pins the rules of the Cheapest, Fastest, LocalFirst and PrivacyFirst
 * strategies that routing.test.ts leaves open: 'down' candidates are
 * dropped, an unknown cost or latency sorts last, a single known cost side
 * counts alone, and the local/cloud split of the fallback chain. Local
 * candidates all use provider 'ollama' (the only LOCAL_PROVIDERS entry),
 * so every assertion compares modelIds, which are unique per case.
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

function ids(candidates: RoutingCandidate[]): string[] {
  return candidates.map((c) => c.model.modelId);
}

describe('CheapestStrategy cost rules', () => {
  const strategy = new CheapestStrategy();

  it('drops down candidates from select and the fallback chain', () => {
    const context = contextOf([
      makeCandidate('openai', 'dear-degraded', { costInput: 0.02, costOutput: 0.02, status: 'degraded' }),
      makeCandidate('openai', 'cheap-down', { costInput: 0.001, costOutput: 0.001, status: 'down' }),
      makeCandidate('openai', 'mid', { costInput: 0.01, costOutput: 0.01 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('mid');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['dear-degraded']);
  });

  it('sorts a model with neither cost after every priced model', () => {
    const context = contextOf([
      makeCandidate('openai', 'unpriced', {}),
      makeCandidate('openai', 'dear', { costInput: 0.03, costOutput: 0.06 }),
      makeCandidate('openai', 'cheap', { costInput: 0.001, costOutput: 0.002 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('cheap');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['dear', 'unpriced']);
  });

  it('ranks a model with only an input cost by that input cost alone', () => {
    // both: 0.001 + 0.002 = 0.003; inputOnly: 0.002 + 0 = 0.002.
    const context = contextOf([
      makeCandidate('openai', 'both', { costInput: 0.001, costOutput: 0.002 }),
      makeCandidate('openai', 'inputOnly', { costInput: 0.002 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('inputOnly');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['both']);
  });

  it('ranks a model with only an output cost by that output cost alone', () => {
    // both: 0.001 + 0.002 = 0.003; outputOnly: 0 + 0.0025 = 0.0025.
    const context = contextOf([
      makeCandidate('openai', 'both', { costInput: 0.001, costOutput: 0.002 }),
      makeCandidate('openai', 'outputOnly', { costOutput: 0.0025 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('outputOnly');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['both']);
  });

  it('builds the fallback chain as the sorted list minus the selected candidate', () => {
    const a = makeCandidate('openai', 'a', { costInput: 0.02, costOutput: 0.02 });
    const b = makeCandidate('openai', 'b', { costInput: 0.01, costOutput: 0.01 });
    const c = makeCandidate('openai', 'c', { costInput: 0.03, costOutput: 0.03 });
    const context = contextOf([a, b, c]);
    const chain = strategy.buildFallbackChain(context);
    expect(strategy.select(context)).toBe(b);
    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(a);
    expect(chain[1]).toBe(c);
    expect(chain).not.toContain(b);
  });

  it('returns null and an empty chain for no candidates and for all-down candidates', () => {
    const empty = contextOf([]);
    expect(strategy.select(empty)).toBeNull();
    expect(strategy.buildFallbackChain(empty)).toEqual([]);
    const allDown = contextOf([
      makeCandidate('openai', 'x', { costInput: 0.01, costOutput: 0.01, status: 'down' }),
      makeCandidate('openai', 'y', { costInput: 0.02, costOutput: 0.02, status: 'down' }),
    ]);
    expect(strategy.select(allDown)).toBeNull();
    expect(strategy.buildFallbackChain(allDown)).toEqual([]);
  });

  it('keeps input order for two unpriced models', () => {
    const forward = contextOf([makeCandidate('openai', 'p', {}), makeCandidate('openai', 'q', {})]);
    expect(strategy.select(forward)?.model.modelId).toBe('p');
    expect(ids(strategy.buildFallbackChain(forward))).toEqual(['q']);
    const reversed = contextOf([makeCandidate('openai', 'q', {}), makeCandidate('openai', 'p', {})]);
    expect(strategy.select(reversed)?.model.modelId).toBe('q');
    expect(ids(strategy.buildFallbackChain(reversed))).toEqual(['p']);
  });
});

describe('FastestStrategy latency and health rules', () => {
  const strategy = new FastestStrategy();

  it('sorts a candidate with no latency after every measured one', () => {
    const context = contextOf([
      makeCandidate('openai', 'unmeasured', {}),
      makeCandidate('openai', 'slow', { latencyMs: 500 }),
      makeCandidate('openai', 'fast', { latencyMs: 50 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('fast');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['slow', 'unmeasured']);
  });

  it('drops a down candidate and keeps a degraded one', () => {
    const context = contextOf([
      makeCandidate('openai', 'quick-down', { latencyMs: 10, status: 'down' }),
      makeCandidate('openai', 'healthy', { latencyMs: 120 }),
      makeCandidate('openai', 'degraded', { latencyMs: 80, status: 'degraded' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('degraded');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['healthy']);
  });
});

describe('LocalFirstStrategy local and cloud ordering', () => {
  const strategy = new LocalFirstStrategy();

  it('selects the fastest cloud candidate when the only ollama candidate is down', () => {
    const context = contextOf([
      makeCandidate('ollama', 'local-down', { latencyMs: 10, status: 'down' }),
      makeCandidate('openai', 'cloud-slow', { latencyMs: 200 }),
      makeCandidate('anthropic', 'cloud-fast', { latencyMs: 50 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('cloud-fast');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['cloud-slow']);
  });

  it('chains the remaining ollama candidates by latency, then the cloud candidates by latency', () => {
    const context = contextOf([
      makeCandidate('openai', 'cloud-x', { latencyMs: 50 }),
      makeCandidate('ollama', 'ollama-a', { latencyMs: 300 }),
      makeCandidate('anthropic', 'cloud-y', { latencyMs: 20 }),
      makeCandidate('ollama', 'ollama-b', { latencyMs: 100 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('ollama-b');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['ollama-a', 'cloud-y', 'cloud-x']);
  });

  it('keeps a degraded ollama first and an unmeasured ollama ahead of a faster cloud candidate', () => {
    const context = contextOf([
      makeCandidate('openai', 'cloud', { latencyMs: 10 }),
      makeCandidate('ollama', 'ollama-unmeasured', {}),
      makeCandidate('ollama', 'ollama-degraded', { latencyMs: 400, status: 'degraded' }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('ollama-degraded');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['ollama-unmeasured', 'cloud']);
  });
});

describe('PrivacyFirstStrategy local-only rule and cloud fallback', () => {
  const strategy = new PrivacyFirstStrategy();

  it('selects the faster ollama and chains only the other ollama, never a faster cloud candidate', () => {
    const context = contextOf([
      makeCandidate('openai', 'cloud-fast', { latencyMs: 5 }),
      makeCandidate('ollama', 'ollama-slow', { latencyMs: 200 }),
      makeCandidate('ollama', 'ollama-fast', { latencyMs: 80 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('ollama-fast');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['ollama-slow']);
  });

  it('selects a single healthy ollama and chains nothing even when a cloud candidate is faster', () => {
    const context = contextOf([
      makeCandidate('openai', 'cloud-fast', { latencyMs: 5 }),
      makeCandidate('ollama', 'ollama-only', { latencyMs: 300 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('ollama-only');
    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });

  it('falls back to the fastest healthy cloud candidate when the ollama candidate is down', () => {
    const context = contextOf([
      makeCandidate('ollama', 'ollama-down', { latencyMs: 1, status: 'down' }),
      makeCandidate('openai', 'cloud-a', { latencyMs: 300 }),
      makeCandidate('anthropic', 'cloud-down', { latencyMs: 2, status: 'down' }),
      makeCandidate('anthropic', 'cloud-b', { latencyMs: 100 }),
      makeCandidate('groq', 'cloud-c', { latencyMs: 200 }),
    ]);
    expect(strategy.select(context)?.model.modelId).toBe('cloud-b');
    expect(ids(strategy.buildFallbackChain(context))).toEqual(['cloud-c', 'cloud-a']);
  });
});
