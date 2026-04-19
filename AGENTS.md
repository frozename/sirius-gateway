# AGENTS.md — sirius-gateway

Agent instructions for any AI coding tool (Claude Code, Cursor,
Codex, Copilot, Gemini, Jules) working in this repo. See
`README.md` for the user-facing overview.

## What this repo is

Unified OpenAI-compatible AI gateway. One endpoint fronting many
providers (OpenAI, Anthropic, Together, Groq, Mistral, a local
llama.cpp server via llamactl, and a file-backed stub for tests).
Routing + policy + observability + usage metering on top of the
`AiProvider` contract from `@nova/contracts`.

## Tech stack

- **Runtime**: Bun 1.3+.
- **Framework**: NestJS 11 + Fastify 5.
- **Language**: TypeScript 5.7+, strict, `"type": "module"`.
- **Validation**: Zod 4.3+ (`@nova/contracts`) + `class-validator`
  for DTOs at controller boundaries.
- **Logging**: pino + pino-http + pino-pretty (dev).
- **Nova**: `@nova/contracts` + `@nova/mcp-shared` via `file:`.

## Layout

```
apps/
├── sirius-api/                NestJS HTTP gateway on Fastify
│   └── src/
│       ├── controllers/       chat, embeddings, responses, models,
│       │                       health
│       ├── gateway.service.ts
│       ├── exception.filter.ts
│       ├── app.module.ts
│       └── main.ts
└── sirius-mcp/                stdio MCP server (@sirius/mcp)

libs/
├── sirius-core/               ProviderRegistry + shared types +
│                               UnifiedAi* interfaces
├── sirius-auth/               bearer auth module
├── sirius-compat-openai/      OpenAI wire-format parse + format
├── sirius-model-registry/     /v1/models aggregation
├── sirius-observability/      interceptor, latency tracker,
│                               streaming observer, usage recorder
├── sirius-policy/             retry / circuit-breaker / rate-limit
├── sirius-routing/            strategy-based selection
├── provider-*/                per-provider adapters implementing
                                AiProvider from @nova/contracts
```

## Commands

```bash
bun install
bun run dev            # watch mode on :3000
bun run start          # one-shot
bun run build          # bundle
bun run test           # bun:test across workspace
bun run typecheck      # tsc --noEmit project-wide
bun run lint
bun run format

bun apps/sirius-mcp/bin/sirius-mcp.ts    # MCP server
```

## Code style

- **TypeScript strict**; no `any` in new code; no `@ts-ignore`
  unless paired with a `// @ts-expect-error` justification in a
  test.
- **No comments explaining WHAT.** Reserve comments for WHY.
- **Module headers** are fine — one short paragraph over a file
  earns its keep when the module touches multiple concerns.
- **No backwards-compat shims** when deleting things. Delete and
  update consumers.
- **Fail loud at boundaries**, silent in the hot path. Controllers
  return structured error envelopes with an `X-Request-Id`; the
  policy layer logs + retries; usage recording swallows errors (never
  blocks a response on telemetry).

## NestJS conventions

- **Providers registered via `@Module({ providers, exports })`**.
  Exports are explicit — if a service is used across modules, it's
  listed in `exports` or it doesn't cross.
- **`@Injectable()`** on every service, obviously.
- **Interface-typed constructor params need `@Optional() @Inject(TOKEN)`.**
  NestJS DI resolves via class metadata; an interface (`UsageRecorderDeps`)
  has no runtime representation. Example in
  `libs/sirius-observability/src/usage-recorder.service.ts` —
  `USAGE_RECORDER_DEPS` symbol token + `@Optional()` keeps tests
  constructible without wiring DI.
- **Controllers are thin.** Parse → service call → format → send.
  Record usage alongside the send on the non-streaming success path.
- **Streaming controllers** (`stream: true`) bypass the observer
  interceptor (they write directly to `res.raw`). Usage for
  streaming is deferred to N.3.3 — upstream must be configured with
  `stream_options: { include_usage: true }` before we can capture
  totals.
- **Exception filter** lives at `apps/sirius-api/src/exception.filter.ts`;
  every error surfaces with a `code` + `message` + `X-Request-Id`.

## Provider adapters

Every provider lives in `libs/provider-<name>/` and implements
`AiProvider` from `@nova/contracts`. Adding a provider:

1. `bun init` a new workspace package under `libs/provider-<name>/`.
2. Re-export `createOpenAICompatProvider(...)` from `@nova/contracts`
   if the upstream speaks OpenAI-compat — zero adapter code. See
   `libs/provider-openai/src/openai.adapter.ts` for the pattern.
3. If the upstream speaks a different dialect (Anthropic-native),
   implement `AiProvider` directly — chat, streamResponse, embeddings,
   health, listModels. Follow
   `libs/provider-anthropic/src/anthropic.adapter.ts`.
4. Register in `apps/sirius-api/src/app.module.ts` via
   `ProviderRegistry`.
5. Add adapter tests: build a real `UnifiedAiRequest`, stub the
   HTTP layer, assert request + response shape end-to-end.

## Usage metering (N.3.2)

- Every non-streaming chat / embedding / responses path calls
  `this.usageRecorder.record({ provider, model, kind,
  promptTokens, completionTokens, totalTokens, latencyMs,
  requestId, route? })`.
- The record ultimately lands via `@nova/mcp-shared`'s
  `appendUsageBackground` under
  `~/.llamactl/usage/<provider>-<YYYY-MM-DD>.jsonl` (override:
  `LLAMACTL_USAGE_DIR`).
- **Never** add prompt content to the record. Tokens + timestamps +
  provider/model/route/requestId only.
- Pricing join (dollar amounts) is llamactl's N.3.4 — leave
  `estimated_cost_usd` blank here.

## Testing

- `bun:test`. Controller tests use manual mocks
  (`mockGateway = { createResponse: mock() }`) — no `@nestjs/testing`
  `TestingModule` required for the thin controller surface.
- **Controller test fixtures must include realistic shapes.** A
  `UnifiedAiResponse` needs `usage`, `latencyMs`, and `_gatewayMeta`
  — the usage recorder reads those. Use:
  ```ts
  const gatewayRes = {
    id: 'res-1',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 100,
    _gatewayMeta: { provider: 'x', model: 'y', strategy: 'round-robin' },
  };
  ```
- **E2E tests** under `apps/sirius-api/src/__tests__/e2e.test.ts`
  boot a real `NestFactory.create` + Fastify. Require
  `SIRIUS_API_KEYS` env var.
- Provider adapter tests stub `fetch` — don't hit real upstreams.

## Cross-repo discipline

This repo depends on Nova. After any Nova schema change:

```bash
bun install      # refresh file: lockfile
bun test         # sirius must stay green
```

Before shipping a sirius change that touches the `UsageRecord` shape
or the `AiProvider` interface, lift the schema into `@nova/contracts`
first, then bump every consumer's lockfile.

Keep sirius, llamactl, embersynth, and nova all green. Current
baseline: sirius ≥ 250 tests.

## What to avoid

- Importing framework deps (Nest, Fastify) into `libs/provider-*`.
  Adapters should stay runtime-agnostic so they work in an MCP
  server or a CLI.
- Writing Anthropic-specific fields into `UsageRecord`. The record
  shape comes from `@nova/contracts`; if you need a field sirius
  can't already emit, add it to Nova first.
- Direct Prisma / DB access from a controller. Sirius has no DB
  yet; if one appears, it goes through a repository layer.
- Hardcoded API keys in tests. Use `process.env` with an explicit
  `beforeEach` setup.
- Portuguese / non-English identifiers. English throughout.

## Key references

- `README.md` — overview + quick start.
- `docs/nova-migration.md` — how the pre-Nova schemas mapped to
  `@nova/contracts`.
- `../nova/AGENTS.md` — Nova SDK rules (schema discipline).
