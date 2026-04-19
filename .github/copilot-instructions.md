# GitHub Copilot Instructions — sirius-gateway

Condensed digest. Authoritative rules live in [`AGENTS.md`](../AGENTS.md).

## What this repo is

Unified OpenAI-compatible AI gateway. One endpoint fronting many
providers (OpenAI, Anthropic, Together, Groq, Mistral, a local
llama.cpp via llamactl, plus a file-backed stub for tests). Routing
+ policy + observability + usage metering.

## Stack

- Bun 1.3+, TypeScript 5.7+ strict.
- NestJS 11 + Fastify 5.
- Zod 4.3+ (via `@nova/contracts`) + `class-validator` at controller
  boundaries.
- pino + pino-http for logs.
- `@nova/contracts` + `@nova/mcp-shared` via `file:` deps.

## Layout

```
apps/sirius-api/            NestJS HTTP gateway
apps/sirius-mcp/            stdio MCP server
libs/sirius-*/              shared types, auth, routing, policy,
                             observability, compat-openai
libs/provider-*/            per-provider adapters (AiProvider impl)
```

## Hard rules

- **TypeScript strict.** No `any`, no `@ts-ignore`.
- **NestJS DI:** interface-typed constructor params need
  `@Optional() @Inject(TOKEN)`. Interfaces have no runtime shape;
  Nest's injector crashes without the token.
- **Controllers are thin:** parse → service → format → send →
  record usage (non-streaming).
- **Provider adapters implement `AiProvider`** from
  `@nova/contracts`. OpenAI-compat upstreams use
  `createOpenAICompatProvider(...)` directly.
- **Usage records never contain prompts.** Tokens + timestamps +
  metadata only.
- **English** identifiers.
- **Bun** for commands.
- **No tool / AI attribution** in commits.

## Tests

- `bun:test`. Controller tests use manual mocks; e2e tests boot a
  real Fastify server.
- Controller fixtures for non-streaming chat/embeddings/responses
  MUST include `usage`, `latencyMs`, `_gatewayMeta` — the usage
  recorder reads them.

## Streaming

- Streaming paths (`stream: true`) write to `res.raw` directly and
  bypass the observability interceptor.
- Usage recording on streams is N.3.3 (requires
  `stream_options: { include_usage: true }` upstream config).

## Cross-repo

Depends on Nova. After any Nova schema change:
```bash
bun install && bun test && bun run typecheck
```
Baseline: sirius ≥ 250 tests green.

## Key references

- `AGENTS.md` — full rules.
- `README.md` — user overview, config, usage recording.
- `docs/nova-migration.md` — pre-Nova → `@nova/contracts`.
