# JULES.md — sirius-gateway

Jules (Google's async coding agent) entrypoint. Defers to
[`AGENTS.md`](./AGENTS.md) as the authoritative source.

Jules runs in a cloud VM and produces a PR. Tasks come from GitHub
issues; output is one focused commit.

## Before opening a PR

1. Read `AGENTS.md` at the repo root.
2. Identify the package(s) the issue touches:
   - `apps/sirius-api/` for HTTP surface changes.
   - `libs/provider-*/` for adapter changes.
   - `libs/sirius-core/` for shared types or registry.
   - `libs/sirius-observability/` for logging / metering.
   - `libs/sirius-policy/` for retry / rate-limit logic.
   - `libs/sirius-routing/` for routing strategy.
3. Verify baseline green:
   ```bash
   bun install && bun test && bun run typecheck
   ```

## Scope rules

- **One slice per PR.**
- **No layer shortcuts.** Controllers are thin; provider adapters
  don't know about NestJS; `libs/sirius-core` is the vocabulary.
- **Cross-repo sync is the user's responsibility.** If your change
  needs a Nova bump, note it in the PR body.

## Non-negotiables

- **TypeScript strict.** No `any`, no `@ts-ignore`, no
  `as unknown as X`.
- **NestJS DI** — interface-typed constructor params MUST use
  `@Optional() @Inject(TOKEN)`.
- **Provider adapters implement `AiProvider`** from
  `@nova/contracts`.
- **Usage records never contain prompt content.** Tokens +
  timestamps + metadata only.
- **Bun** only.
- **English** identifiers throughout.
- **No tool / AI attribution** in commits.

## PR body checklist

- Problem (link to issue).
- Approach (2-4 sentences).
- Test deltas + any new controller-fixture shapes.
- Cross-repo impact: Nova bump needed? Embersynth / llamactl
  knock-on? List explicitly.
- Streaming vs non-streaming path coverage for chat / embedding /
  responses controllers.

## Commands

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run dev              # local verification
```

## Layout cheatsheet

```
apps/sirius-api/         NestJS HTTP gateway
apps/sirius-mcp/         stdio MCP server
libs/sirius-core/        shared types + ProviderRegistry
libs/sirius-auth/        bearer auth
libs/sirius-compat-openai/  OpenAI wire shims
libs/sirius-*/           routing, policy, observability,
                          model-registry
libs/provider-*/         per-provider adapters
```
