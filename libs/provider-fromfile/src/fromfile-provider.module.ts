import { Injectable, Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry, nova } from '@sirius/core';
import type { AiProvider, ModelInfo, ProviderHealth } from '@sirius/core';
import { loadProvidersFile, resolveApiKeyRef, resolveFilePath } from './loader.js';

/**
 * Anthropic's public API version. The `/v1/models` + `/v1/messages`
 * endpoints require this as the `anthropic-version` header. Kept as a
 * single const so the date is visible and updates touch one site.
 */
const ANTHROPIC_API_VERSION = '2023-06-01';

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
 * Anthropic's native `/v1/models` + `/v1/messages` endpoints require
 * `x-api-key` + `anthropic-version` headers, NOT `Authorization:
 * Bearer`. Their experimental OpenAI-compat `/v1/chat/completions`
 * endpoint accepts Bearer, which is why Nova's openai-compat factory
 * handles chat fine but blows up at boot on `/v1/models`.
 *
 * Rather than teach Nova's generic factory about provider-specific
 * auth, we do the Anthropic-native `/models` + `/models/{id}` call
 * directly here when the fromfile entry's `kind === 'anthropic'` and
 * overlay the result on top of the Nova chat adapter. Chat continues
 * to use the compat endpoint (which works with Bearer); only the
 * model-listing + health-probe paths swap to native auth.
 */
interface AnthropicNativeShape {
  baseUrl: string;
  apiKey: string;
  providerName: string;
}

async function listAnthropicNativeModels(
  opts: AnthropicNativeShape,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ModelInfo[]> {
  const base = opts.baseUrl.endsWith('/')
    ? opts.baseUrl.slice(0, -1)
    : opts.baseUrl;
  const res = await fetchImpl(`${base}/models`, {
    method: 'GET',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `${opts.providerName} /models ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  const raw = (await res.json()) as {
    data?: Array<{
      id?: string;
      display_name?: string;
      created_at?: string;
      type?: string;
    }>;
  };
  // Anthropic's `/v1/models` returns dated ids only (e.g.
  // `claude-haiku-4-5-20251001`), but the runtime chat endpoint
  // ALSO accepts the undated alias `claude-haiku-4-5`. Operators
  // write the undated form in most docs + UIs, so we emit both the
  // dated id and the undated alias so either routes correctly. The
  // dated form is the canonical `id` we return — if a date suffix
  // is absent, no alias is emitted.
  const out: ModelInfo[] = [];
  for (const m of raw.data ?? []) {
    const id = String(m.id ?? '');
    if (!id) continue;
    const created = m.created_at
      ? Math.floor(new Date(m.created_at).getTime() / 1000)
      : undefined;
    const info: ModelInfo = { id, provider: opts.providerName };
    if (Number.isFinite(created)) info.created = created as number;
    info.ownedBy = 'anthropic';
    out.push(info);
    const undated = stripAnthropicDateSuffix(id);
    if (undated && undated !== id) {
      out.push({ id: undated, provider: opts.providerName, ownedBy: 'anthropic' });
    }
  }
  return out;
}

/**
 * Strip a trailing `-YYYYMMDD` suffix from an Anthropic model id.
 * `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. If the id does
 * not match the pattern, returns `null` (don't emit a bogus alias).
 *
 * This is the Anthropic-specific counterpart to Gemini's
 * `models/<name>` canonicalisation — both upstreams expose a
 * canonical "dated" form in `/v1/models` that differs from the
 * undated alias operators actually type.
 */
function stripAnthropicDateSuffix(id: string): string | null {
  const match = id.match(/^(.+)-(\d{8})$/);
  if (!match) return null;
  return match[1]!;
}

async function probeAnthropicHealth(
  opts: AnthropicNativeShape,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderHealth> {
  const base = opts.baseUrl.endsWith('/')
    ? opts.baseUrl.slice(0, -1)
    : opts.baseUrl;
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${base}/models?limit=1`, {
      method: 'GET',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        provider: opts.providerName,
        status: res.status >= 500 ? 'down' : 'degraded',
        lastChecked: new Date(),
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    return {
      provider: opts.providerName,
      status: 'healthy',
      lastChecked: new Date(),
      latencyMs,
    };
  } catch (err) {
    return {
      provider: opts.providerName,
      status: 'down',
      lastChecked: new Date(),
      error: (err as Error).message,
    };
  }
}

/**
 * Wrap the sirius-legacy AiProvider produced by `toSiriusAdapter` so
 * its `listModels()` + `healthCheck()` hit Anthropic's native API
 * with `x-api-key` instead of going through Nova's Bearer-auth
 * openai-compat wrapper. Chat paths are untouched — those already
 * work against Anthropic's OpenAI-compat endpoint.
 *
 * Exported for the unit test to reach directly.
 */
export function overlayAnthropicNativeAuth(
  adapter: AiProvider,
  entry: { name: string; baseUrl?: string; apiKeyRef?: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): AiProvider {
  const baseUrl =
    entry.baseUrl ??
    DEFAULT_BASE_URLS.anthropic ??
    'https://api.anthropic.com/v1';
  const apiKey = resolveApiKeyRef(entry.apiKeyRef);
  const nativeOpts: AnthropicNativeShape = {
    baseUrl,
    apiKey,
    providerName: entry.name,
  };
  return {
    ...adapter,
    listModels: () => listAnthropicNativeModels(nativeOpts, fetchImpl),
    healthCheck: () => probeAnthropicHealth(nativeOpts, fetchImpl),
  };
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
      let adapter = toSiriusAdapter(entry.name, core);
      if (entry.kind === 'anthropic') {
        adapter = overlayAnthropicNativeAuth(adapter, entry);
      }
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
                let adapter = toSiriusAdapter(entry.name, core);
                if (entry.kind === 'anthropic') {
                  adapter = overlayAnthropicNativeAuth(adapter, entry);
                }
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
