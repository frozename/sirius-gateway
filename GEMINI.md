# GEMINI.md — sirius-gateway

Gemini CLI entrypoint. Defers to [`AGENTS.md`](./AGENTS.md) as the
authoritative source; this file calls out Gemini-specific nudges.

## Before any task

1. Read `AGENTS.md` (full rules, style, NestJS DI gotchas).
2. Read `README.md` for user-facing surface + usage recording
   semantics.
3. If the task touches schemas in `@nova/contracts`, lift the
   change into Nova first, bump, refresh lockfile here.

## Non-negotiables

- **TypeScript strict** — no `any` in new code, no `@ts-ignore`.
- **NestJS DI**: interface-typed constructor params need
  `@Optional() @Inject(TOKEN)`. Interfaces have no runtime
  representation; bare interface params crash Nest's injector. See
  `libs/sirius-observability/src/usage-recorder.service.ts` for the
  pattern (`USAGE_RECORDER_DEPS` symbol).
- **Controllers are thin.** Parse → service call → format → send
  → record usage (non-streaming success path). Move logic out of
  controllers.
- **Provider adapters implement `AiProvider`** from
  `@nova/contracts`. OpenAI-compat upstreams reuse
  `createOpenAICompatProvider(...)`; zero adapter code.
- **Usage records never contain prompt content.** Tokens +
  timestamps + provider/model/route/requestId only.
- **Bun** only. **English** identifiers.

## Runtime + commands

```bash
bun install
bun run dev                    # :3000 watch
bun run start                  # one-shot
bun run test
bun run typecheck
bun run lint
bun apps/sirius-mcp/bin/sirius-mcp.ts
```

## Cross-repo

Depends on Nova. After a Nova bump:

```bash
bun install
bun test
bun run typecheck
```

Baseline: sirius ≥ 250 tests.

## Where to look

- `apps/sirius-api/src/controllers/` — HTTP surface.
- `apps/sirius-api/src/gateway.service.ts` — routing + fallback +
  policy glue.
- `libs/sirius-core/src/` — `ProviderRegistry`, shared types.
- `libs/sirius-observability/src/usage-recorder.service.ts` — N.3.2
  usage recording.
- `libs/provider-*/` — per-provider adapters.
