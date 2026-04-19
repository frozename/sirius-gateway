import { Injectable, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry, nova } from '@sirius/core';
import type { AiProvider } from '@sirius/core';
import { loadProvidersFile, resolveApiKeyRef, resolveFilePath } from './loader.js';

/**
 * Reads llamactl's `sirius-providers.yaml` at boot and registers a
 * provider per entry. Pairs with `llamactl sirius add-provider` as
 * the friendly front-end for managing provider configs.
 *
 * Each entry materialises through `nova.createOpenAICompatProvider`
 * (all our currently-supported upstreams speak OpenAI-wire — even
 * Anthropic's beta `/v1`). The adapter is wrapped in a
 * sirius-legacy-shape translator identical to the one in
 * `@sirius/provider-llamactl`, so the existing GatewayService and
 * ProviderRegistry see a normal `AiProvider` instance.
 */

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
};

function novaProviderFor(entry: {
  name: string;
  kind: string;
  apiKeyRef?: string;
  baseUrl?: string;
  displayName?: string;
}): nova.AiProvider {
  const baseUrl = entry.baseUrl ?? DEFAULT_BASE_URLS[entry.kind] ?? '';
  if (!baseUrl) {
    throw new Error(
      `sirius provider '${entry.name}' (${entry.kind}) has no baseUrl and no default`,
    );
  }
  const apiKey = resolveApiKeyRef(entry.apiKeyRef);
  return nova.createOpenAICompatProvider({
    name: entry.name,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    baseUrl,
    apiKey,
  });
}

/**
 * Minimal sirius-legacy AiProvider shim around a nova provider.
 * Keeps the `GatewayService` happy during the nova migration by
 * translating response / stream / model / health shapes at the
 * boundary. Identical pattern to `LlamactlAdapter`.
 */
function toSiriusAdapter(name: string, core: nova.AiProvider): AiProvider {
  return {
    name,
    async createResponse(req) {
      const novaReq: nova.UnifiedAiRequest = {
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role as nova.Role,
          content: typeof m.content === 'string' ? m.content : '',
        })),
        stream: req.stream,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      };
      const res = await core.createResponse(novaReq);
      const choice = res.choices[0];
      const content =
        typeof choice?.message.content === 'string' ? choice.message.content : '';
      return {
        id: res.id,
        model: res.model,
        provider: name,
        content: [{ type: 'text', text: content }],
        finishReason: (choice?.finish_reason ?? 'stop') as 'stop',
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
          totalTokens: res.usage?.total_tokens ?? 0,
        },
        latencyMs: res.latencyMs ?? 0,
      };
    },
    async *streamResponse(req) {
      const novaReq: nova.UnifiedAiRequest = {
        model: req.model,
        messages: req.messages.map((m) => ({
          role: m.role as nova.Role,
          content: typeof m.content === 'string' ? m.content : '',
        })),
        stream: true,
      };
      const stream = core.streamResponse?.(novaReq);
      if (!stream) {
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      for await (const ev of stream) {
        if (ev.type === 'chunk') {
          const delta = ev.chunk.choices[0]?.delta.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'content_delta', delta };
          }
        } else if (ev.type === 'error') {
          yield {
            type: 'error',
            error: ev.error.message,
            ...(ev.error.code ? { code: ev.error.code } : {}),
          };
        } else if (ev.type === 'done') {
          yield { type: 'done', finishReason: ev.finish_reason ?? 'stop' };
        }
      }
    },
    async createEmbeddings(req) {
      if (!core.createEmbeddings) {
        throw new Error(`${name}: embeddings not supported`);
      }
      const res = await core.createEmbeddings({
        model: req.model,
        input: req.input,
        ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
        ...(req.user !== undefined ? { user: req.user } : {}),
      });
      return {
        id: `emb-${Date.now()}`,
        model: res.model,
        provider: name,
        embeddings: res.data.map((row) =>
          Array.isArray(row.embedding) ? (row.embedding as number[]) : [],
        ),
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: 0,
          totalTokens: res.usage?.total_tokens ?? 0,
        },
        latencyMs: res.latencyMs ?? 0,
      };
    },
    async listModels() {
      if (!core.listModels) return [];
      const models = await core.listModels();
      return models.map((m) => ({
        id: m.id,
        provider: name,
        ...(m.created !== undefined ? { created: m.created } : {}),
        ...(m.owned_by !== undefined ? { ownedBy: m.owned_by } : {}),
      }));
    },
    async healthCheck() {
      if (!core.healthCheck) {
        return { provider: name, status: 'healthy', lastChecked: new Date() };
      }
      const h = await core.healthCheck();
      return {
        provider: name,
        status:
          h.state === 'healthy'
            ? 'healthy'
            : h.state === 'unhealthy'
              ? 'down'
              : 'degraded',
        ...(h.latencyMs != null ? { latencyMs: h.latencyMs } : {}),
        lastChecked: new Date(h.lastChecked),
        ...(h.error ? { error: h.error } : {}),
      };
    },
  };
}

/**
 * Build (or rebuild) the set of from-file adapters, update the
 * registry, and return a reconciliation report.
 *
 * Pure-ish — the only side effect is registering / unregistering
 * on the passed-in registry. Shared by the boot factory below + the
 * reload service.
 */
export interface FromFileReloadResult {
  path: string;
  added: string[];
  removed: string[];
  kept: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function reconcileFromFileProviders(
  path: string,
  registry: ProviderRegistry,
  /** Current from-file-owned provider names. Boot passes `[]`; a
   *  reload call passes the names registered in the previous
   *  reconciliation so this function knows which to unregister. */
  previouslyOwned: readonly string[],
): { result: FromFileReloadResult; ownedAfter: string[] } {
  const entries = loadProvidersFile(path);
  const wanted = new Set(entries.map((e) => e.name));
  const prev = new Set(previouslyOwned);

  // Remove providers that disappeared from the file.
  const removed: string[] = [];
  for (const name of prev) {
    if (!wanted.has(name)) {
      registry.unregister(name);
      removed.push(name);
    }
  }

  const added: string[] = [];
  const kept: string[] = [];
  const skipped: FromFileReloadResult['skipped'] = [];
  const ownedAfter: string[] = [];
  for (const entry of entries) {
    try {
      const core = novaProviderFor(entry);
      const adapter = toSiriusAdapter(entry.name, core);
      const wasPresent = registry.get(entry.name) !== undefined;
      registry.register(adapter);
      ownedAfter.push(entry.name);
      if (wasPresent && prev.has(entry.name)) {
        kept.push(entry.name);
      } else {
        added.push(entry.name);
      }
    } catch (err) {
      skipped.push({ name: entry.name, reason: (err as Error).message });
    }
  }
  return {
    result: { path, added, removed, kept, skipped },
    ownedAfter,
  };
}

/**
 * Runtime reload hook. Holds the resolved path + the set of
 * provider names the from-file loader currently owns so the
 * admin endpoint can re-scan the yaml and reconcile the registry
 * without restarting sirius.
 */
@Injectable()
export class FromFileReloadService {
  private path: string;
  private owned: readonly string[] = [];

  constructor(
    config: ConfigService,
    private readonly registry: ProviderRegistry,
  ) {
    this.path = resolvePath(config);
  }

  /** Called once at boot by the FROMFILE_ADAPTERS factory so the
   *  reload service tracks which providers are from-file-owned. */
  setOwned(names: readonly string[]): void {
    this.owned = [...names];
  }

  getPath(): string {
    return this.path;
  }

  /** Override the path at runtime (tests). */
  setPath(path: string): void {
    this.path = path;
  }

  reload(): FromFileReloadResult {
    const { result, ownedAfter } = reconcileFromFileProviders(
      this.path,
      this.registry,
      this.owned,
    );
    this.owned = ownedAfter;
    return result;
  }
}

function resolvePath(config: ConfigService): string {
  return (
    config.get<string>('LLAMACTL_PROVIDERS_FILE', '') || resolveFilePath()
  );
}

@Module({})
export class FromFileProviderModule {
  static forRootAsync(): DynamicModule {
    return {
      module: FromFileProviderModule,
      providers: [
        FromFileReloadService,
        {
          provide: 'FROMFILE_ADAPTERS',
          useFactory: (
            config: ConfigService,
            registry: ProviderRegistry,
            reloader: FromFileReloadService,
          ): AiProvider[] => {
            const path = resolvePath(config);
            const entries = loadProvidersFile(path);
            const adapters: AiProvider[] = [];
            const owned: string[] = [];
            for (const entry of entries) {
              try {
                const core = novaProviderFor(entry);
                const adapter = toSiriusAdapter(entry.name, core);
                registry.register(adapter);
                adapters.push(adapter);
                owned.push(entry.name);
              } catch (err) {
                // Fail-soft — one bad entry shouldn't crash sirius's
                // boot. Logging hook belongs to the caller.
                // eslint-disable-next-line no-console
                console.warn(
                  `[provider-fromfile] skipped '${entry.name}': ${(err as Error).message}`,
                );
              }
            }
            reloader.setOwned(owned);
            return adapters;
          },
          inject: [ConfigService, ProviderRegistry, FromFileReloadService],
        },
      ],
      exports: ['FROMFILE_ADAPTERS', FromFileReloadService],
    };
  }
}
