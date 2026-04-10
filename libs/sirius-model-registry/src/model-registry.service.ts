import { Injectable } from '@nestjs/common';
import type { ModelCapabilityMatrix } from '@sirius/core';
import { DEFAULT_MODEL_CATALOG } from './model-catalog.js';

@Injectable()
export class ModelRegistryService {
  private readonly models = new Map<string, ModelCapabilityMatrix>();
  private readonly aliasMap = new Map<string, string[]>();

  constructor() {
    for (const model of DEFAULT_MODEL_CATALOG) {
      this.registerModel(model);
    }
  }

  /**
   * Resolve a model string (exact id or alias) to its canonical id and provider.
   * If multiple providers exist, returns the first one registered.
   */
  resolveModel(
    modelString: string,
  ): { modelId: string; provider: string } | null {
    // 1. Try exact match on composite key "provider:modelId"
    if (modelString.includes(':')) {
      const model = this.models.get(modelString);
      if (model) {
        return { modelId: model.modelId, provider: model.provider };
      }
    }

    // 2. Try match on modelId (canonical ID)
    for (const model of this.models.values()) {
      if (model.modelId === modelString) {
        return { modelId: model.modelId, provider: model.provider };
      }
    }

    // 3. Try match on alias
    const canonicalIds = this.aliasMap.get(modelString);
    if (canonicalIds && canonicalIds.length > 0) {
      const model = this.models.get(canonicalIds[0]!);
      if (model) {
        return { modelId: model.modelId, provider: model.provider };
      }
    }

    return null;
  }

  /**
   * Get the full capability matrix for a model by its provider and canonical id.
   */
  getCapabilities(
    modelId: string,
    provider?: string,
  ): ModelCapabilityMatrix | undefined {
    if (provider) {
      return this.models.get(`${provider}:${modelId}`);
    }
    // If no provider, return the first one found with this modelId
    for (const model of this.models.values()) {
      if (model.modelId === modelId) {
        return model;
      }
    }
    return undefined;
  }

  /**
   * Return all registered models.
   */
  listModels(): ModelCapabilityMatrix[] {
    return [...this.models.values()];
  }

  /**
   * Return all models belonging to a specific provider.
   */
  listModelsForProvider(provider: string): ModelCapabilityMatrix[] {
    return [...this.models.values()].filter((m) => m.provider === provider);
  }

  /**
   * Register a model at runtime (e.g. discovered via provider list-models).
   */
  addModel(model: ModelCapabilityMatrix): void {
    this.registerModel(model);
  }

  /**
   * Return all providers that can serve a given model id.
   */
  getProvidersForModel(modelId: string): string[] {
    const providers: string[] = [];
    for (const model of this.models.values()) {
      if (model.modelId === modelId) {
        providers.push(model.provider);
      }
    }
    return providers;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private registerModel(model: ModelCapabilityMatrix): void {
    const key = `${model.provider}:${model.modelId}`;
    this.models.set(key, model);
    for (const alias of model.aliases) {
      const existing = this.aliasMap.get(alias) ?? [];
      if (!existing.includes(key)) {
        existing.push(key);
        this.aliasMap.set(alias, existing);
      }
    }
  }
}
