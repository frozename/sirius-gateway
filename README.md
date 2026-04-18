# Sirius Gateway

Unified AI Gateway — a single OpenAI-compatible HTTP API in front of OpenAI,
Anthropic, and Ollama. Drop-in replacement for the OpenAI SDK that adds
routing, fallback, retries, a circuit breaker, streaming, and observability.

Built on NestJS + Fastify, runs on Bun.

## Features

- **OpenAI-compatible endpoints** — `v1/chat/completions`, `v1/responses`,
  `v1/embeddings`, `v1/models`. Point any OpenAI SDK at the gateway URL and it
  just works (including SSE streaming).
- **Multi-provider** — ships with adapters for OpenAI, Anthropic, and Ollama.
  Requests are normalised to a shared internal schema, so request/response
  shape is identical regardless of the upstream provider.
- **Model registry** — a capability matrix (chat, streaming, tools,
  embeddings, vision, json mode, context window, per-1k cost) for every known
  model, with alias resolution so `claude-sonnet-4` routes to
  `claude-sonnet-4-20250514`.
- **Routing strategies** — `pinned`, `fastest`, `cheapest`, `balanced`,
  `local-first`, and `privacy-first`. Strategies pick a primary provider and
  build a fallback chain from the candidates that satisfy the request's
  required capabilities.
- **Resilience policy** — per-provider retries with exponential backoff,
  request timeouts, and a circuit breaker that trips after repeated failures
  and auto-resets on a configurable cooldown. Applies to both unary and
  streaming calls.
- **Observability** — structured JSON logs via pino, request IDs propagated on
  `X-Request-Id`, latency tracking per provider, and stream-event observation
  (TTFT, idle timeout, tokens, errors).
- **Bearer-token auth** — simple comma-separated API key list via
  `SIRIUS_API_KEYS`. Health endpoints are public.

## Architecture

Bun workspaces monorepo. One app, nine libraries.

```
apps/
  sirius-api/                   # NestJS + Fastify HTTP app (entrypoint)
libs/
  sirius-core/                  # Shared types: AiProvider, UnifiedAiRequest,
                                #   UnifiedStreamEvent, ProviderRegistry, ...
  sirius-compat-openai/         # OpenAI wire-format <-> unified schema
  sirius-model-registry/        # Model catalog + capability/alias lookup
  sirius-routing/               # Routing strategies + fallback chains
  sirius-policy/                # Retries, timeouts, circuit breaker
  sirius-observability/         # pino logging, latency tracker, stream observer
  sirius-auth/                  # Bearer-token guard + @Public() decorator
  provider-openai/              # OpenAI adapter, mapper, stream parser
  provider-anthropic/           # Anthropic adapter, mapper, stream parser
  provider-ollama/              # Ollama adapter, mapper, stream parser
```

Request flow for a chat completion:

1. `ChatCompletionsController` receives the OpenAI-format request.
2. `OpenAiCompatService` parses it into a `UnifiedAiRequest`.
3. `GatewayService` asks `RoutingService` for a `RoutingDecision` (primary +
   fallback chain) based on the configured strategy.
4. For each candidate in the chain, `PolicyService` wraps the provider call
   with retry, timeout, and circuit-breaker logic.
5. The selected provider's adapter makes the upstream HTTP call and maps the
   response back to the unified schema.
6. `OpenAiCompatService` formats the unified response (or stream chunks) back
   into OpenAI wire format and the controller writes it to the client.

## Requirements

- [Bun](https://bun.sh) 1.x
- Node-compatible runtime (TypeScript compiles against `@types/bun` and
  targets the Bun runtime specifically — `bun` is required for `dev`,
  `start`, and `build`).
- API keys for whichever cloud providers you want to enable
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). For local models, a running Ollama
  instance.

## Getting started

```bash
bun install
cp .env.example .env
# edit .env — set SIRIUS_API_KEYS and at least one provider key
bun run dev
```

The server binds to `SIRIUS_HOST:SIRIUS_PORT` (default `0.0.0.0:3000`). On
startup it logs the active providers, configured model count, and default
routing strategy.

Point any OpenAI client at it:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-sirius-dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": false
  }'
```

Or with the OpenAI SDK:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-sirius-dev-key',
  baseURL: 'http://localhost:3000/v1',
});

const res = await client.chat.completions.create({
  model: 'claude-sonnet-4',
  messages: [{ role: 'user', content: 'hello' }],
});
```

## Endpoints

| Method | Path                  | Description                                      | Auth |
| ------ | --------------------- | ------------------------------------------------ | ---- |
| POST   | `/v1/chat/completions`| OpenAI Chat Completions (sync + SSE streaming)   | Yes  |
| POST   | `/v1/responses`       | OpenAI Responses API (sync + SSE streaming)      | Yes  |
| POST   | `/v1/embeddings`      | OpenAI Embeddings                                | Yes  |
| GET    | `/v1/models`          | Merged list of provider-reported + catalog models| Yes  |
| GET    | `/v1/models/:id`      | Lookup a single model by id or alias             | Yes  |
| GET    | `/health`             | Liveness + gateway stats                         | No   |
| GET    | `/providers/health`   | Per-provider health + circuit-breaker state      | No   |

Every response carries an `X-Request-Id` header, matched in logs.

## Configuration

All configuration is environment-driven (see `.env.example`). `ConfigModule`
loads `.env.local` then `.env`.

| Variable                            | Default                     | Purpose                                                |
| ----------------------------------- | --------------------------- | ------------------------------------------------------ |
| `SIRIUS_HOST`                       | `0.0.0.0`                   | Bind host                                              |
| `SIRIUS_PORT`                       | `3000`                      | Bind port                                              |
| `SIRIUS_LOG_LEVEL`                  | `debug`                     | pino log level                                         |
| `SIRIUS_API_KEYS`                   | —                           | Comma-separated Bearer tokens accepted by the guard    |
| `SIRIUS_CORS_ORIGIN`                | `*`                         | CORS allow-origin                                      |
| `SIRIUS_DEFAULT_STRATEGY`           | `pinned`                    | Default routing strategy                               |
| `SIRIUS_DEFAULT_MODEL`              | `gpt-4o`                    | Fallback model when none is specified                  |
| `SIRIUS_RETRY_MAX_ATTEMPTS`         | `2`                         | Max retries per provider call                          |
| `SIRIUS_RETRY_BASE_DELAY_MS`        | `500`                       | Exponential backoff base                               |
| `SIRIUS_TIMEOUT_MS`                 | `60000`                     | Per-call timeout                                       |
| `SIRIUS_CIRCUIT_BREAKER_THRESHOLD`  | `5`                         | Consecutive failures before the breaker opens          |
| `SIRIUS_CIRCUIT_BREAKER_RESET_MS`   | `30000`                     | How long the breaker stays open before half-retry      |
| `SIRIUS_STREAM_IDLE_TIMEOUT_MS`     | `30000`                     | Abort a stream that produces no events for this long   |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL`| — / `https://api.openai.com`| OpenAI provider credentials                            |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | — / `https://api.anthropic.com` | Anthropic provider credentials              |
| `OLLAMA_BASE_URL`                   | `http://localhost:11434`    | Ollama instance URL                                    |

A provider is only registered at startup if its required env is set. Leaving
`OPENAI_API_KEY` empty, for example, disables the OpenAI provider without
breaking the others.

## Routing strategies

| Strategy        | Selection rule                                                                 |
| --------------- | ------------------------------------------------------------------------------ |
| `pinned`        | Resolve the requested model to its single provider. No fallback.               |
| `fastest`       | Rank healthy candidates by average observed latency.                           |
| `cheapest`      | Rank by `costPer1kInput + costPer1kOutput` from the model catalog.             |
| `balanced`      | Weighted blend of latency and cost.                                            |
| `local-first`   | Prefer local providers (Ollama); fall back to cloud.                           |
| `privacy-first` | Only return local providers. Cloud is used only if no local candidate exists.  |

A strategy also builds a `fallbackChain`. If the primary fails through the
policy layer (after retries, or because the circuit is open), the gateway
tries each fallback in order — and records `fallbackUsed: true` on
`_gatewayMeta` when one is taken.

## Scripts

```bash
bun run dev        # watch mode
bun run start      # run once
bun run build      # bundle to ./dist
bun test           # run all test suites
bun run typecheck  # tsc --noEmit
bun run lint       # eslint
bun run format     # prettier
```

Tests live alongside the code in `__tests__` directories. E2E tests for the
HTTP surface are in `apps/sirius-api/src/__tests__/e2e.test.ts`.

## Adding a provider

1. Create `libs/provider-<name>/` with an `AiProvider` implementation. An
   adapter typically owns: `createResponse`, `streamResponse`,
   `createEmbeddings`, `listModels`, `healthCheck` — plus a mapper (unified
   <-> provider wire format) and a stream parser.
2. Register its module in `apps/sirius-api/src/app.module.ts` (usually as
   `forRootAsync()` so env is only read at boot).
3. Add the provider's models to `libs/sirius-model-registry/src/model-catalog.ts`
   with their capability matrix and (optionally) pricing.
4. Add a path alias in `tsconfig.json` under `compilerOptions.paths`.

The `ProviderRegistry` picks up anything registered at boot; no further
wiring is needed in the routing or policy layers.

## License

Private / unpublished (`"private": true` in `package.json`).
