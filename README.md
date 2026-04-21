# sirius-gateway

Unified AI gateway. One OpenAI-compatible endpoint fronting many
providers — OpenAI, Anthropic, Together, Groq, Mistral, a local
llama.cpp server via llamactl, and any file-backed stub for testing.
Routing, policy, observability, and usage metering in a single Bun
+ NestJS + Fastify service.

## Why

Applications don't want to learn each provider's SDK quirks. Sirius
speaks `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses`,
`/v1/models`, and `/healthz` — and decides per-request which upstream
should actually run it, with fallback chains, rate-limit policy, and
latency tracking on the hot path.

## Features

- **OpenAI-compatible surface** — chat completions (streaming +
  non-streaming), embeddings, responses API, model listing.
- **Pluggable providers** — each upstream lives in its own workspace
  package (`libs/provider-openai`, `provider-anthropic`,
  `provider-together`, etc.). Adding a provider = implementing
  `AiProvider` from `@nova/contracts`. File-backed stub provider
  (`provider-fromfile`) makes deterministic tests trivial.
- **Routing + policy** — `libs/sirius-routing` picks an upstream per
  request (round-robin, tag-based, explicit model pinning);
  `libs/sirius-policy` applies retry + circuit-breaker + rate-limit
  wrappers uniformly. Fallback chains degrade gracefully when an
  upstream refuses traffic.
- **Observability** — structured pino logs, request-id propagation,
  per-provider latency tracker, streaming observer for SSE metrics.
- **Usage metering (N.3.2)** — every non-streaming chat / embedding /
  responses request appends a `UsageRecord` (`@nova/contracts` shape)
  to `~/.llamactl/usage/<provider>-<YYYY-MM-DD>.jsonl`. Feeds
  `nova.ops.cost.snapshot` and the cost-guardian agent. Zero
  request-path latency impact — writes via `queueMicrotask`.
- **MCP server** — `@sirius/mcp` projects sirius's operator surface
  (providers list / register / deregister, usage recent) as MCP tools
  so Claude or any MCP client can drive the gateway directly.
- **Nova-native** — adapters, schemas, and contracts all live in
  `@nova/contracts`; sirius is just a routing + policy overlay on
  top.

## Repo layout

```
apps/
├── sirius-api/                    NestJS HTTP gateway on Fastify
│   ├── src/
│   │   ├── controllers/           chat, embeddings, responses,
│   │   │                           models, health
│   │   ├── gateway.service.ts     routing + fallback + policy glue
│   │   ├── exception.filter.ts
│   │   ├── app.module.ts
│   │   └── main.ts
│   └── ...
└── sirius-mcp/                    stdio MCP server (@sirius/mcp)

libs/
├── sirius-core/                   ProviderRegistry + shared types
├── sirius-auth/                   bearer auth module
├── sirius-compat-openai/          OpenAI wire-format shims
├── sirius-model-registry/         /v1/models aggregation
├── sirius-observability/          interceptor, latency tracker,
│                                  streaming observer, usage recorder
├── sirius-policy/                 retry, circuit breaker, rate limit
├── sirius-routing/                strategy-based provider selection
├── provider-anthropic/            Anthropic adapter
├── provider-fromfile/             deterministic stub (tests)
├── provider-llamactl/             local llama.cpp via llamactl agent
├── provider-ollama/               Ollama adapter
└── provider-openai/               OpenAI adapter
```

## Quick start

```bash
bun install

# Minimum config via env vars:
export SIRIUS_API_KEYS='sk-test-token-1,sk-test-token-2'
export OPENAI_API_KEY=sk-...            # any provider-specific env

bun run dev                             # starts on :3000
curl -sS -H 'Authorization: Bearer sk-test-token-1' \
  http://localhost:3000/v1/models | jq .
```

### Chat request

```bash
curl -sS http://localhost:3000/v1/chat/completions \
  -H 'Authorization: Bearer sk-test-token-1' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}]
  }' | jq .
```

Streaming: pass `"stream": true`; the response is SSE framed the
same way OpenAI does it, so any OpenAI client library works
unchanged.

## Configuration surface

- **Providers** — `~/.llamactl/sirius-providers.yaml` (when running
  alongside llamactl) or `SIRIUS_PROVIDERS_YAML` env var pointing at
  an alternate file. Each entry binds an upstream adapter name to
  optional `baseUrl` + `apiKeyRef` (env var name or absolute path).
- **Routing strategy** — default is round-robin over healthy
  providers; override via env / config.
- **Policy** — retry count, circuit-breaker thresholds, per-provider
  rate limits — all configurable; see `libs/sirius-policy/src/`.
- **Hot reload** — `POST /providers/reload` (bearer-auth) re-reads
  `sirius-providers.yaml` and reconciles the registry in place
  (add new, unregister deleted, keep unchanged). Used by the
  `llamactl` sirius gateway workload handler and by operators after
  hand-editing the YAML. Returns a diff for audit:
  `{ok, path, added, removed, kept, skipped}`.

## Usage metering

Every upstream call sirius brokers records one line:

```json
{
  "ts": "2026-04-19T12:34:56.000Z",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "kind": "chat",
  "prompt_tokens": 42,
  "completion_tokens": 17,
  "total_tokens": 59,
  "latency_ms": 310,
  "request_id": "req-abc...",
  "route": "round-robin"
}
```

Files rotate daily under `~/.llamactl/usage/` (override with
`LLAMACTL_USAGE_DIR`). Read-side lives in `@nova/mcp-shared`'s
`readUsage()` + `@nova/mcp`'s `nova.ops.cost.snapshot`. Pricing-
joined dollar amounts come with llamactl's N.3.4.

Privacy: **prompts are never recorded**. Token counts, timestamps,
model + provider + route only.

## MCP server

```bash
bun apps/sirius-mcp/bin/sirius-mcp.ts
```

stdio transport, exposes `sirius.providers.*` + `sirius.usage.recent`
tools. Wire into Claude Desktop or any MCP client with:

```json
{
  "mcpServers": {
    "sirius": {
      "command": "bun",
      "args": ["/abs/path/to/sirius-gateway/apps/sirius-mcp/bin/sirius-mcp.ts"]
    }
  }
}
```

## Dev commands

```bash
bun test         # all workspace tests (bun:test)
bun run dev      # watch mode on :3000
bun run start    # one-shot
bun run build    # bundle
bun run typecheck
bun run lint
bun run format
```

## Docker build

`apps/sirius-api` ships a production-ready multi-stage Dockerfile at
`apps/sirius-api/Dockerfile`. Build it from the PARENT directory that
contains both `sirius-gateway/` and `nova/` — the gateway depends on
`@nova/contracts` + `@nova/mcp-shared` via `file:../nova/packages/*`,
so `bun install` inside the image needs nova on disk:

```sh
# From the parent dir that contains both sirius-gateway/ and nova/
cd "$(dirname sirius-gateway)"
docker build \
  -f sirius-gateway/apps/sirius-api/Dockerfile \
  -t llamactl/sirius-api:dev \
  .
```

The image pins `oven/bun:1.3.13` for the builder and
`oven/bun:1.3.13-slim` for the runtime, runs as the non-root `bun`
user, listens on `${SIRIUS_PORT:-3000}` bound to `0.0.0.0`, and ships
a `HEALTHCHECK` that hits `GET /health`.

Intended for `llamactl composite apply` workflows: build locally,
tag `llamactl/sirius-api:dev`, and Docker Desktop K8s pulls from the
local daemon via `imagePullPolicy: IfNotPresent` — no registry push
required for dev.

Run standalone:

```sh
docker run --rm -p 3000:3000 \
  -e SIRIUS_API_KEYS=sk-test-token \
  -e OPENAI_API_KEY=sk-... \
  llamactl/sirius-api:dev
```

BuildKit-only: a `Dockerfile.dockerignore` sits next to the Dockerfile
and excludes `node_modules`, `dist`, `.git`, `.env*`, and unrelated
sibling repos from the build context.

## Family + docs

- Canonical contracts and shared helpers live in
  [nova](../nova/).
- llamactl is the single-operator control plane:
  [llamactl](../llamactl/).
- Capability-based model orchestration for multi-node setups:
  [embersynth](../embersynth/).
- Migration notes from pre-Nova schemas: `docs/nova-migration.md`.

## License

MIT.
