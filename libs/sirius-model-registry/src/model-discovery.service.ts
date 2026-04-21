import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ProviderRegistry,
  type AiProvider,
  type ModelCapabilityMatrix,
  type ModelInfo,
} from '@sirius/core';
import { ModelRegistryService } from './model-registry.service.js';

/**
 * Runs once after Nest finishes wiring and every time the from-file
 * provider reload runs. For each provider registered on the
 * `ProviderRegistry`, calls `listModels()` and upserts every result
 * into `ModelRegistryService` so routing can resolve models that
 * weren't baked into `DEFAULT_MODEL_CATALOG` (e.g. local llama-server
 * aliases, llamactl nodes, ad-hoc openai-compatible endpoints).
 *
 * Running inside `onApplicationBootstrap` means every provider
 * module (fromfile, llamactl, built-in openai/anthropic/ollama) has
 * already pushed its adapters into the registry, so one pass covers
 * the entire fleet — no need to bolt backfill into each provider
 * module.
 */
@Injectable()
export class ModelDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModelDiscoveryService.name);

  /**
   * Bootstrap-only retry delay. A `listModels()` call that returns
   * `[]` without throwing is ambiguous — the upstream might be
   * legitimately empty, or it might be transiently unreachable (DNS
   * resolution for `host.docker.internal`, container start races,
   * etc.). A single 2s retry covers the common race; the reload
   * hot-path covers the "upstream came back much later" case.
   *
   * Mutable per-instance so the unit tests can collapse it to ~0ms
   * without waiting two real seconds. Production callers never touch
   * it — default is 2s.
   */
  bootRetryDelayMs = 2_000;

  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly modelRegistry: ModelRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.backfillAll();
  }

  /**
   * Discover and register models for every provider currently in the
   * registry. Errors are logged per-provider but never propagate —
   * one upstream being unreachable must not stop sirius from booting.
   *
   * Emits an explicit start / end log pair so operators can diagnose
   * bootstrap-time failures from pod logs even when every provider
   * returns 0 models (silence is the failure mode we're guarding
   * against).
   */
  async backfillAll(): Promise<{ provider: string; added: number }[]> {
    const providers = this.providerRegistry.getAll();
    const names = providers.map((p) => p.name);
    this.logger.log(
      `boot: discovering models for ${providers.length} provider(s): [${names.join(', ')}]`,
    );

    const report: { provider: string; added: number }[] = [];
    await Promise.all(
      providers.map(async (provider) => {
        const added = await this.backfillProvider(provider, { retryOnZero: true });
        report.push({ provider: provider.name, added });
      }),
    );

    const totalModels = report.reduce((sum, r) => sum + r.added, 0);
    const nonZeroProviders = report.filter((r) => r.added > 0).length;
    this.logger.log(
      `boot: discovery complete — registered ${totalModels} model(s) across ${nonZeroProviders}/${providers.length} provider(s)`,
    );
    return report;
  }

  /**
   * Discover + register for a single named provider. Used by the
   * reload hot-path when the set of providers (or their upstream
   * model lists) may have changed. Does NOT retry — reload is
   * already an externally-triggered rescan, so a transient blip can
   * be fixed by hitting the endpoint again.
   */
  async backfillProviderByName(name: string): Promise<number> {
    const provider = this.providerRegistry.get(name);
    if (!provider) return 0;
    return this.backfillProvider(provider, { retryOnZero: false });
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async backfillProvider(
    provider: AiProvider,
    opts: { retryOnZero: boolean },
  ): Promise<number> {
    const first = await this.probeProvider(provider);
    if (first.threw) {
      return 0;
    }
    if (first.models.length > 0 || !opts.retryOnZero) {
      return this.registerModels(provider, first.models);
    }

    // `listModels()` returned `[]` without throwing — ambiguous at
    // boot. One retry with a short backoff to cover the DNS /
    // container-start race. If it's still empty, we emit the warn
    // log below and move on.
    await sleep(this.bootRetryDelayMs);
    const second = await this.probeProvider(provider);
    if (second.threw) {
      return 0;
    }
    return this.registerModels(provider, second.models);
  }

  private async probeProvider(
    provider: AiProvider,
  ): Promise<{ models: ModelInfo[]; threw: boolean }> {
    try {
      const models = await provider.listModels();
      return { models, threw: false };
    } catch (err) {
      const suffix = describeProviderEndpoint(provider);
      this.logger.warn(
        `[${provider.name}] listModels() failed: ${(err as Error).message}${suffix}`,
      );
      return { models: [], threw: true };
    }
  }

  private registerModels(provider: AiProvider, models: ModelInfo[]): number {
    let added = 0;
    for (const info of models) {
      const matrix = toCapabilityMatrix(info, provider.name);
      this.modelRegistry.addModel(matrix);
      added += 1;
    }
    if (added > 0) {
      this.logger.log(
        `[${provider.name}] registered ${added} discovered model(s)`,
      );
    } else {
      const suffix = describeProviderEndpoint(provider);
      this.logger.warn(
        `[${provider.name}] listModels() returned 0 — provider will not be routable until next reload${suffix}`,
      );
    }
    return added;
  }
}

/**
 * Heuristics for classifying a `ModelInfo` returned from a
 * provider's `listModels()`. We intentionally stay conservative —
 * every model is assumed to be a chat model unless its id matches a
 * known embedding-model naming pattern (OpenAI `text-embedding-*`,
 * Ollama `nomic-embed-*`, etc). This is good enough to route until
 * upstreams start declaring capabilities in their `/models` payload.
 */
export function toCapabilityMatrix(
  info: ModelInfo,
  providerName: string,
): ModelCapabilityMatrix {
  const id = info.id;
  const embeddings = looksLikeEmbeddingModel(id);
  return {
    modelId: id,
    provider: providerName,
    aliases: [id],
    capabilities: {
      chat: !embeddings,
      streaming: !embeddings,
      tools: false,
      embeddings,
      vision: false,
      jsonMode: false,
    },
    // Conservative defaults — real context window depends on the
    // specific weights each upstream serves. Routing uses this only
    // for cost scoring, and the downstream call still enforces the
    // actual limit.
    contextWindow: 8_192,
    maxOutputTokens: embeddings ? 0 : 4_096,
  };
}

function looksLikeEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('embed') ||
    lower.startsWith('text-embedding') ||
    lower.endsWith('-embed') ||
    lower.includes('-embedding-')
  );
}

/**
 * Typesafe probe for a provider's baseUrl. The `AiProvider` interface
 * deliberately does NOT guarantee this field, but many concrete
 * adapters (fromfile, llamactl, openai) carry it for diagnostics.
 * When present, we append it to the log so operators can tell at a
 * glance which endpoint was unreachable.
 */
function describeProviderEndpoint(provider: AiProvider): string {
  const candidate = (provider as { baseUrl?: unknown }).baseUrl;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return ` (baseUrl=${candidate})`;
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
