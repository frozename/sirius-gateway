import { describe, it, expect } from 'bun:test';
import type { RoutingCandidate, RoutingContext } from '../strategies/routing-strategy.interface';
import { PinnedStrategy } from '../strategies/pinned.strategy';
import { FastestStrategy } from '../strategies/fastest.strategy';
import { CheapestStrategy } from '../strategies/cheapest.strategy';
import { LocalFirstStrategy } from '../strategies/local-first.strategy';
import { PrivacyFirstStrategy } from '../strategies/privacy-first.strategy';
import type { ModelCapabilityMatrix, ProviderHealth } from '../../../sirius-core/src/index.js';

function makeCandidate(
  provider: string,
  modelId: string,
  overrides?: { latencyMs?: number; costInput?: number; costOutput?: number; status?: 'healthy' | 'degraded' | 'down' },
): RoutingCandidate {
  return {
    model: {
      modelId,
      provider,
      aliases: [],
      capabilities: { chat: true, streaming: true, tools: true, embeddings: false, vision: false, jsonMode: false },
      contextWindow: 128000,
      maxOutputTokens: 16384,
      costPer1kInput: overrides?.costInput ?? 0.01,
      costPer1kOutput: overrides?.costOutput ?? 0.03,
    } as ModelCapabilityMatrix,
    health: {
      provider,
      status: overrides?.status ?? 'healthy',
      latencyMs: overrides?.latencyMs ?? 100,
      lastChecked: new Date(),
    } as ProviderHealth,
  };
}

describe('PinnedStrategy', () => {
  const strategy = new PinnedStrategy();

  it('selects the single healthy candidate', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [makeCandidate('openai', 'gpt-4o')],
    };

    const result = strategy.select(context);
    expect(result).not.toBeNull();
    expect(result!.model.provider).toBe('openai');
  });

  it('selects the exact model match when multiple candidates exist', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('anthropic', 'gpt-4o'),
        makeCandidate('openai', 'gpt-4o'),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('anthropic');
  });

  it('returns null when no candidates', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [],
    };

    expect(strategy.select(context)).toBeNull();
  });

  it('skips down providers', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('openai', 'gpt-4o', { status: 'down' }),
        makeCandidate('fallback', 'gpt-4o'),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('fallback');
  });

  it('returns empty fallback chain', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [makeCandidate('openai', 'gpt-4o')],
    };

    expect(strategy.buildFallbackChain(context)).toEqual([]);
  });
});

describe('FastestStrategy', () => {
  const strategy = new FastestStrategy();

  it('selects the provider with lowest latency', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('slow', 'gpt-4o', { latencyMs: 500 }),
        makeCandidate('fast', 'gpt-4o', { latencyMs: 50 }),
        makeCandidate('medium', 'gpt-4o', { latencyMs: 200 }),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('fast');
  });

  it('builds fallback chain in latency order', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('slow', 'gpt-4o', { latencyMs: 500 }),
        makeCandidate('fast', 'gpt-4o', { latencyMs: 50 }),
        makeCandidate('medium', 'gpt-4o', { latencyMs: 200 }),
      ],
    };

    const chain = strategy.buildFallbackChain(context);
    // Fallback chain excludes the primary (fastest), so only medium + slow remain
    expect(chain.map((c) => c.model.provider)).toEqual(['medium', 'slow']);
  });
});

describe('CheapestStrategy', () => {
  const strategy = new CheapestStrategy();

  it('selects the cheapest provider', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('expensive', 'gpt-4o', { costInput: 0.03, costOutput: 0.06 }),
        makeCandidate('cheap', 'gpt-4o', { costInput: 0.001, costOutput: 0.002 }),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('cheap');
  });
});

describe('LocalFirstStrategy', () => {
  const strategy = new LocalFirstStrategy();

  it('prefers ollama over cloud providers', () => {
    const context: RoutingContext = {
      requestedModel: 'llama3.2',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('openai', 'llama3.2', { latencyMs: 100 }),
        makeCandidate('ollama', 'llama3.2', { latencyMs: 200 }),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('ollama');
  });
});

describe('PrivacyFirstStrategy', () => {
  const strategy = new PrivacyFirstStrategy();

  it('only returns local providers when available', () => {
    const context: RoutingContext = {
      requestedModel: 'llama3.2',
      requiredCapabilities: ['chat'],
      candidates: [
        makeCandidate('openai', 'llama3.2'),
        makeCandidate('ollama', 'llama3.2'),
      ],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('ollama');

    const chain = strategy.buildFallbackChain(context);
    // Privacy-first with only one local provider: fallback chain is empty (primary was ollama)
    expect(chain).toHaveLength(0);
  });

  it('falls back to cloud when no local providers', () => {
    const context: RoutingContext = {
      requestedModel: 'gpt-4o',
      requiredCapabilities: ['chat'],
      candidates: [makeCandidate('openai', 'gpt-4o')],
    };

    const result = strategy.select(context);
    expect(result!.model.provider).toBe('openai');
  });
});
