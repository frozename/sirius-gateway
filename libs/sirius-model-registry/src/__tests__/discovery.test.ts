import { describe, it, expect, beforeEach } from 'bun:test';
import { ProviderRegistry, type AiProvider } from '@sirius/core';
import { ModelRegistryService } from '../model-registry.service';
import {
  ModelDiscoveryService,
  normalizeModelId,
  toCapabilityMatrix,
} from '../model-discovery.service';

/**
 * Unit tests for the discover-and-register bridge that keeps the
 * ModelRegistry's routing map in sync with providers' live
 * `listModels()` output. Fixes the boot-time bug where routing
 * short-circuited for any model not in `DEFAULT_MODEL_CATALOG`.
 */

function fakeProvider(
  name: string,
  models: string[],
  opts: { failListing?: boolean } = {},
): AiProvider {
  return {
    name,
    async createResponse() {
      throw new Error('not-impl');
    },
    async *streamResponse() {
      yield { type: 'done', finishReason: 'stop' } as const;
    },
    async createEmbeddings() {
      throw new Error('not-impl');
    },
    async listModels() {
      if (opts.failListing) throw new Error('upstream down');
      return models.map((id) => ({ id, provider: name, ownedBy: 'llamacpp' }));
    },
    async healthCheck() {
      return { provider: name, status: 'healthy' as const, lastChecked: new Date() };
    },
  };
}

describe('ModelDiscoveryService', () => {
  let providerRegistry: ProviderRegistry;
  let modelRegistry: ModelRegistryService;
  let discovery: ModelDiscoveryService;

  beforeEach(() => {
    providerRegistry = new ProviderRegistry();
    modelRegistry = new ModelRegistryService();
    discovery = new ModelDiscoveryService(providerRegistry, modelRegistry);
  });

  it('addModel + resolveModel round-trips a freshly-discovered model', () => {
    const matrix = toCapabilityMatrix(
      { id: 'qwen2.5-0.5b-instruct', provider: 'local-llm', ownedBy: 'llamacpp' },
      'local-llm',
    );
    modelRegistry.addModel(matrix);

    const resolved = modelRegistry.resolveModel('qwen2.5-0.5b-instruct');
    expect(resolved).not.toBeNull();
    expect(resolved?.modelId).toBe('qwen2.5-0.5b-instruct');
    expect(resolved?.provider).toBe('local-llm');
  });

  it('backfillAll() walks every registered provider and adds every model', async () => {
    providerRegistry.register(fakeProvider('local-llm', ['qwen2.5-0.5b-instruct']));
    providerRegistry.register(
      fakeProvider('llamactl-gpu1', ['llama3.2-8b', 'text-embedding-nomic']),
    );

    const report = await discovery.backfillAll();
    const added = Object.fromEntries(report.map((r) => [r.provider, r.added]));
    expect(added).toEqual({
      'local-llm': 1,
      'llamactl-gpu1': 2,
    });

    expect(modelRegistry.resolveModel('qwen2.5-0.5b-instruct')).toEqual({
      modelId: 'qwen2.5-0.5b-instruct',
      provider: 'local-llm',
    });
    expect(modelRegistry.resolveModel('llama3.2-8b')).toEqual({
      modelId: 'llama3.2-8b',
      provider: 'llamactl-gpu1',
    });
  });

  it('does not clobber models already in DEFAULT_MODEL_CATALOG', async () => {
    // gpt-4o is in the default catalog under the 'openai' provider.
    // After backfill, requesting 'gpt-4o' without a provider prefix
    // should still resolve to the openai entry (first-registered).
    providerRegistry.register(fakeProvider('local-llm', ['my-local-model']));
    await discovery.backfillAll();

    const resolved = modelRegistry.resolveModel('gpt-4o');
    expect(resolved?.modelId).toBe('gpt-4o');
    expect(resolved?.provider).toBe('openai');
  });

  it('classifies embedding-looking ids as embeddings', () => {
    const m1 = toCapabilityMatrix(
      { id: 'nomic-embed-text', provider: 'ollama' },
      'ollama',
    );
    expect(m1.capabilities.embeddings).toBe(true);
    expect(m1.capabilities.chat).toBe(false);

    const m2 = toCapabilityMatrix(
      { id: 'text-embedding-3-small', provider: 'openai-compat' },
      'openai-compat',
    );
    expect(m2.capabilities.embeddings).toBe(true);
    expect(m2.capabilities.chat).toBe(false);

    const m3 = toCapabilityMatrix(
      { id: 'qwen2.5-0.5b-instruct', provider: 'local-llm' },
      'local-llm',
    );
    expect(m3.capabilities.embeddings).toBe(false);
    expect(m3.capabilities.chat).toBe(true);
  });

  it('seeds the raw id as an alias so exact lookups work', () => {
    const matrix = toCapabilityMatrix(
      { id: 'phi-3-mini', provider: 'local-llm' },
      'local-llm',
    );
    expect(matrix.aliases).toContain('phi-3-mini');
  });

  describe('prefix normalisation (e.g. Gemini `models/<name>`)', () => {
    it('strips a single leading `models/` segment on registry entry', async () => {
      // Gemini's OpenAI-compat /models returns `models/gemini-2.5-flash`.
      // Operators naturally write `gemini-2.5-flash` in chat requests.
      providerRegistry.register(
        fakeProvider('gemini', ['models/gemini-2.5-flash']),
      );
      await discovery.backfillAll();

      // Canonical id + unprefixed form both resolve to the same entry.
      const byUnprefixed = modelRegistry.resolveModel('gemini-2.5-flash');
      expect(byUnprefixed).toEqual({
        modelId: 'gemini-2.5-flash',
        provider: 'gemini',
      });

      // Prefixed form still resolves (operators who hardcoded it don't
      // break).
      const byPrefixed = modelRegistry.resolveModel('models/gemini-2.5-flash');
      expect(byPrefixed).toEqual({
        modelId: 'gemini-2.5-flash',
        provider: 'gemini',
      });
    });

    it('leaves ids without a slash unchanged', () => {
      const matrix = toCapabilityMatrix(
        { id: 'claude-haiku-4-5', provider: 'anthropic' },
        'anthropic',
      );
      expect(matrix.modelId).toBe('claude-haiku-4-5');
      expect(matrix.aliases).toEqual(['claude-haiku-4-5']);
    });

    it('leaves multi-slash ids alone (conservative: no over-normalisation)', () => {
      const matrix = toCapabilityMatrix(
        { id: 'organizations/foo/models/bar', provider: 'weird' },
        'weird',
      );
      expect(matrix.modelId).toBe('organizations/foo/models/bar');
      expect(matrix.aliases).toEqual(['organizations/foo/models/bar']);
    });

    it('normalizeModelId returns the expected shape for each case', () => {
      expect(normalizeModelId('models/gemini-2.5-flash')).toEqual({
        canonical: 'gemini-2.5-flash',
        original: 'models/gemini-2.5-flash',
        hadPrefix: true,
      });
      expect(normalizeModelId('gemini-2.5-flash')).toEqual({
        canonical: 'gemini-2.5-flash',
        original: 'gemini-2.5-flash',
        hadPrefix: false,
      });
      expect(normalizeModelId('organizations/foo/models/bar')).toEqual({
        canonical: 'organizations/foo/models/bar',
        original: 'organizations/foo/models/bar',
        hadPrefix: false,
      });
      // Malformed edge cases pass through verbatim rather than
      // silently emitting '' or a surprising canonical.
      expect(normalizeModelId('trailing/')).toEqual({
        canonical: 'trailing/',
        original: 'trailing/',
        hadPrefix: false,
      });
      expect(normalizeModelId('/leading-slash')).toEqual({
        canonical: '/leading-slash',
        original: '/leading-slash',
        hadPrefix: false,
      });
    });
  });

  it('swallows listModels() errors and keeps going with other providers', async () => {
    providerRegistry.register(
      fakeProvider('flaky', ['wont-see-this'], { failListing: true }),
    );
    providerRegistry.register(fakeProvider('good', ['model-a']));

    const report = await discovery.backfillAll();
    const added = Object.fromEntries(report.map((r) => [r.provider, r.added]));
    expect(added.flaky).toBe(0);
    expect(added.good).toBe(1);
    expect(modelRegistry.resolveModel('model-a')?.provider).toBe('good');
    expect(modelRegistry.resolveModel('wont-see-this')).toBeNull();
  });

  it('backfillProviderByName targets a single provider', async () => {
    providerRegistry.register(fakeProvider('just-me', ['just-my-model']));
    providerRegistry.register(fakeProvider('not-me', ['not-my-model']));

    const count = await discovery.backfillProviderByName('just-me');
    expect(count).toBe(1);
    expect(modelRegistry.resolveModel('just-my-model')?.provider).toBe('just-me');
    expect(modelRegistry.resolveModel('not-my-model')).toBeNull();
  });

  it('backfillProviderByName returns 0 for unknown providers', async () => {
    const count = await discovery.backfillProviderByName('missing');
    expect(count).toBe(0);
  });

  it('reload hot-path covers both added + kept providers (cheap upsert)', async () => {
    // Simulates how `HealthController.providersReload()` drives the
    // service: one call per name in `[...added, ...kept]`. A
    // steady-state ConfigMap reload returns `added: []` + a
    // non-empty `kept[]`, so without this coverage discovery never
    // re-runs after boot.
    providerRegistry.register(
      fakeProvider('a-added', ['model-a1', 'model-a2']),
    );
    providerRegistry.register(fakeProvider('b-kept', ['model-b1']));

    const added = ['a-added'];
    const kept = ['b-kept'];
    const results = await Promise.all(
      [...added, ...kept].map((name) =>
        discovery.backfillProviderByName(name),
      ),
    );
    expect(results).toEqual([2, 1]);

    expect(modelRegistry.resolveModel('model-a1')?.provider).toBe('a-added');
    expect(modelRegistry.resolveModel('model-b1')?.provider).toBe('b-kept');
  });

  it('bootstrap: retries once when listModels() returns [] without throwing', async () => {
    // Scenario: adapter is wired, upstream is briefly unreachable at
    // pod bootstrap — DNS for host.docker.internal hadn't settled,
    // for example. First probe returns `[]` (no error), second probe
    // succeeds. Retry should land the model in the registry.
    let call = 0;
    const flappy: AiProvider = {
      name: 'flappy',
      async createResponse() {
        throw new Error('not-impl');
      },
      async *streamResponse() {
        yield { type: 'done', finishReason: 'stop' } as const;
      },
      async createEmbeddings() {
        throw new Error('not-impl');
      },
      async listModels() {
        call += 1;
        return call === 1
          ? []
          : [{ id: 'recovered-model', provider: 'flappy', ownedBy: 'llamacpp' }];
      },
      async healthCheck() {
        return {
          provider: 'flappy',
          status: 'healthy' as const,
          lastChecked: new Date(),
        };
      },
    };
    providerRegistry.register(flappy);

    // Keep the test fast — production default is 2_000ms.
    discovery.bootRetryDelayMs = 1;

    const report = await discovery.backfillAll();
    expect(call).toBe(2);
    const entry = report.find((r) => r.provider === 'flappy');
    expect(entry?.added).toBe(1);
    expect(modelRegistry.resolveModel('recovered-model')?.provider).toBe(
      'flappy',
    );
  });

  it('bootstrap: retry stops at 1 attempt even when the second call also returns []', async () => {
    let call = 0;
    const stillEmpty: AiProvider = {
      name: 'still-empty',
      async createResponse() {
        throw new Error('not-impl');
      },
      async *streamResponse() {
        yield { type: 'done', finishReason: 'stop' } as const;
      },
      async createEmbeddings() {
        throw new Error('not-impl');
      },
      async listModels() {
        call += 1;
        return [];
      },
      async healthCheck() {
        return {
          provider: 'still-empty',
          status: 'healthy' as const,
          lastChecked: new Date(),
        };
      },
    };
    providerRegistry.register(stillEmpty);
    discovery.bootRetryDelayMs = 1;

    const report = await discovery.backfillAll();
    // Exactly one retry — never loops.
    expect(call).toBe(2);
    expect(report.find((r) => r.provider === 'still-empty')?.added).toBe(0);
  });

  it('backfillProviderByName does NOT retry on empty (reload-only path)', async () => {
    let call = 0;
    const p: AiProvider = {
      name: 'reload-target',
      async createResponse() {
        throw new Error('not-impl');
      },
      async *streamResponse() {
        yield { type: 'done', finishReason: 'stop' } as const;
      },
      async createEmbeddings() {
        throw new Error('not-impl');
      },
      async listModels() {
        call += 1;
        return [];
      },
      async healthCheck() {
        return {
          provider: 'reload-target',
          status: 'healthy' as const,
          lastChecked: new Date(),
        };
      },
    };
    providerRegistry.register(p);

    const count = await discovery.backfillProviderByName('reload-target');
    expect(count).toBe(0);
    // Reload is externally triggered; caller retries by hitting the
    // endpoint again. One probe only.
    expect(call).toBe(1);
  });
});
