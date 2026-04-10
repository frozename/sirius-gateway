import { describe, it, expect, beforeEach } from 'bun:test';
import { ModelRegistryService } from '../model-registry.service';

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
