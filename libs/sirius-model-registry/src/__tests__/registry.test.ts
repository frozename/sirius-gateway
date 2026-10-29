import { describe, it, expect, beforeEach } from 'bun:test';
import { ModelRegistryService } from '../model-registry.service';
import type { ModelCapabilityMatrix } from '@sirius/core';

describe('ModelRegistryService', () => {
  let registry: ModelRegistryService;

  beforeEach(() => {
    registry = new ModelRegistryService();
  });

  it('resolves exact model id', () => {
    // GPT-4o is in default catalog
    const resolved = registry.resolveModel('gpt-4o');
    expect(resolved).not.toBeNull();
    expect(resolved?.modelId).toBe('gpt-4o');
    expect(resolved?.provider).toBe('openai');
  });

  it('resolves model alias', () => {
    // 'gpt-4' is an alias for 'gpt-4o' or similar in many setups, 
    // let's check what's actually in DEFAULT_MODEL_CATALOG or just add one.
    registry.addModel({
      modelId: 'canonical-model',
      displayName: 'Canonical Model',
      provider: 'mock',
      aliases: ['alias-1', 'alias-2'],
      capabilities: { chat: true, embeddings: false, vision: false, tools: true, streaming: false, jsonMode: false },
      contextWindow: 8192,
      maxOutputTokens: 4096,
    });

    const resolved = registry.resolveModel('alias-1');
    expect(resolved?.modelId).toBe('canonical-model');
    
    const resolved2 = registry.resolveModel('alias-2');
    expect(resolved2?.modelId).toBe('canonical-model');
  });

  it('returns null for unknown model', () => {
    expect(registry.resolveModel('non-existent')).toBeNull();
  });

  it('gets capabilities for a model', () => {
    const caps = registry.getCapabilities('gpt-4o');
    expect(caps).toBeDefined();
    expect(caps?.capabilities.chat).toBe(true);
  });

  it('lists models for a provider', () => {
    const openaiModels = registry.listModelsForProvider('openai');
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every(m => m.provider === 'openai')).toBe(true);
  });

  it('adds a model at runtime', () => {
    const newModel = {
      modelId: 'new-model',
      displayName: 'New Model',
      provider: 'ollama',
      aliases: [],
      capabilities: { chat: true, embeddings: false, vision: false, tools: false, streaming: false, jsonMode: false },
      contextWindow: 8192,
      maxOutputTokens: 4096,
    };
    
    registry.addModel(newModel);
    
    const resolved = registry.resolveModel('new-model');
    expect(resolved?.modelId).toBe('new-model');
    expect(resolved?.provider).toBe('ollama');
  });

  it('round-trips a discovered qwen2.5-0.5b-instruct entry', () => {
    // Regression test for the boot-time routing bug: models
    // discovered via a provider's `listModels()` must be resolvable
    // by routing, not just the ones baked into
    // `DEFAULT_MODEL_CATALOG`.
    registry.addModel({
      modelId: 'qwen2.5-0.5b-instruct',
      provider: 'local-llm',
      aliases: ['qwen2.5-0.5b-instruct'],
      capabilities: {
        chat: true,
        streaming: true,
        tools: false,
        embeddings: false,
        vision: false,
        jsonMode: false,
      },
      contextWindow: 8192,
      maxOutputTokens: 4096,
    });
    const resolved = registry.resolveModel('qwen2.5-0.5b-instruct');
    expect(resolved).toEqual({
      modelId: 'qwen2.5-0.5b-instruct',
      provider: 'local-llm',
    });
  });

  it('returns all providers for a model id', () => {
    // Add same model id for different providers
    registry.addModel({
      modelId: 'shared-model',
      displayName: 'Shared 1',
      provider: 'provider-a',
      aliases: [],
      capabilities: { chat: true, embeddings: false, vision: false, tools: false, streaming: false, jsonMode: false },
      contextWindow: 8192,
      maxOutputTokens: 4096,
    });
    registry.addModel({
      modelId: 'shared-model',
      displayName: 'Shared 2',
      provider: 'provider-b',
      aliases: [],
      capabilities: { chat: true, embeddings: false, vision: false, tools: false, streaming: false, jsonMode: false },
      contextWindow: 8192,
      maxOutputTokens: 4096,
    });

    const providers = registry.getProvidersForModel('shared-model');
    expect(providers).toContain('provider-a');
    expect(providers).toContain('provider-b');
  });
});

/**
 * Pins the ModelRegistryService paths the cases above leave open: the
 * provider:modelId composite-key lookup in resolveModel (step 1), the
 * provider argument of getCapabilities, re-registration under the same
 * key, and alias precedence. Inline fixtures only; the default catalog
 * is loaded by the constructor but no case depends on its contents.
 */
function fixture(
  provider: string,
  modelId: string,
  displayName: string,
  aliases: string[] = [],
): ModelCapabilityMatrix {
  return {
    modelId,
    displayName,
    provider,
    aliases,
    capabilities: { chat: true, embeddings: false, vision: false, tools: false, streaming: false, jsonMode: false },
    contextWindow: 8192,
    maxOutputTokens: 4096,
  };
}

describe('ModelRegistryService composite keys and re-registration', () => {
  let registry: ModelRegistryService;

  beforeEach(() => {
    registry = new ModelRegistryService();
  });

  it('resolves a provider:modelId key to that provider, not the first registered', () => {
    registry.addModel(fixture('provider-a', 'shared-model', 'Shared A'));
    registry.addModel(fixture('provider-b', 'shared-model', 'Shared B'));
    expect(registry.resolveModel('provider-b:shared-model')).toEqual({ modelId: 'shared-model', provider: 'provider-b' });
    expect(registry.resolveModel('shared-model')).toEqual({ modelId: 'shared-model', provider: 'provider-a' });
  });

  it('resolves a composite key whose modelId itself contains a colon', () => {
    registry.addModel(fixture('ollama', 'qwen3:8b', 'Qwen3 8B'));
    expect(registry.resolveModel('ollama:qwen3:8b')).toEqual({ modelId: 'qwen3:8b', provider: 'ollama' });
    expect(registry.resolveModel('qwen3:8b')).toEqual({ modelId: 'qwen3:8b', provider: 'ollama' });
  });

  it('returns null for a composite key that names no registered entry', () => {
    registry.addModel(fixture('provider-a', 'shared-model', 'Shared A'));
    expect(registry.resolveModel('nope:shared-model')).toBeNull();
    expect(registry.resolveModel('provider-a:other-model')).toBeNull();
  });

  it('scopes getCapabilities to the given provider', () => {
    registry.addModel(fixture('provider-a', 'shared-model', 'Shared A'));
    registry.addModel(fixture('provider-b', 'shared-model', 'Shared B'));
    expect(registry.getCapabilities('shared-model', 'provider-b')?.displayName).toBe('Shared B');
    expect(registry.getCapabilities('shared-model', 'missing')).toBeUndefined();
    expect(registry.getCapabilities('shared-model')?.displayName).toBe('Shared A');
  });

  it('replaces an entry re-registered under the same provider:modelId', () => {
    registry.addModel(fixture('provider-a', 'shared-model', 'First'));
    registry.addModel(fixture('provider-a', 'shared-model', 'Second'));
    const models = registry.listModelsForProvider('provider-a');
    expect(models).toHaveLength(1);
    expect(models[0]?.displayName).toBe('Second');
    expect(registry.getCapabilities('shared-model', 'provider-a')?.displayName).toBe('Second');
    expect(registry.getProvidersForModel('shared-model')).toEqual(['provider-a']);
  });

  it('keeps the first-registered position when an entry is re-registered', () => {
    registry.addModel(fixture('provider-a', 'shared-model', 'A v1'));
    registry.addModel(fixture('provider-b', 'shared-model', 'Shared B'));
    registry.addModel(fixture('provider-a', 'shared-model', 'A v2'));
    expect(registry.resolveModel('shared-model')).toEqual({ modelId: 'shared-model', provider: 'provider-a' });
    expect(registry.getCapabilities('shared-model')?.displayName).toBe('A v2');
    expect(registry.getProvidersForModel('shared-model')).toEqual(['provider-a', 'provider-b']);
  });

  it('resolves a shared alias to the first registered model and does not duplicate a re-added one', () => {
    registry.addModel(fixture('provider-a', 'alias-model-a', 'Alias A', ['shared-alias']));
    registry.addModel(fixture('provider-b', 'alias-model-b', 'Alias B', ['shared-alias']));
    expect(registry.resolveModel('shared-alias')).toEqual({ modelId: 'alias-model-a', provider: 'provider-a' });
    registry.addModel(fixture('provider-a', 'alias-model-a', 'Alias A', ['shared-alias']));
    expect(registry.resolveModel('shared-alias')).toEqual({ modelId: 'alias-model-a', provider: 'provider-a' });
    expect(registry.getProvidersForModel('alias-model-a')).toEqual(['provider-a']);
    expect(registry.getProvidersForModel('alias-model-b')).toEqual(['provider-b']);
  });
});
