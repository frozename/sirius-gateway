import { Module, type DynamicModule } from '@nestjs/common';
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

@Module({})
export class FromFileProviderModule {
  static forRootAsync(): DynamicModule {
    return {
      module: FromFileProviderModule,
      providers: [
        {
          provide: 'FROMFILE_ADAPTERS',
          useFactory: (
            config: ConfigService,
            registry: ProviderRegistry,
          ): AiProvider[] => {
            const path =
              config.get<string>('LLAMACTL_PROVIDERS_FILE', '') ||
              resolveFilePath();
            const entries = loadProvidersFile(path);
            const adapters: AiProvider[] = [];
            for (const entry of entries) {
              try {
                const core = novaProviderFor(entry);
                const adapter = toSiriusAdapter(entry.name, core);
                registry.register(adapter);
                adapters.push(adapter);
              } catch (err) {
                // Fail-soft — one bad entry shouldn't crash sirius's
                // boot. Logging hook belongs to the caller.
                // eslint-disable-next-line no-console
                console.warn(
                  `[provider-fromfile] skipped '${entry.name}': ${(err as Error).message}`,
                );
              }
            }
            return adapters;
          },
          inject: [ConfigService, ProviderRegistry],
        },
      ],
      exports: ['FROMFILE_ADAPTERS'],
    };
  }
}
