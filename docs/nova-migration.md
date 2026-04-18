# Nova migration

Sirius is adopting **Nova** — a canonical, OpenAI-wire-compatible
vocabulary for AI provider contracts — as its long-term type foundation.
Nova lives at `libs/nova` and is exported from `@sirius/core` under a
`nova` namespace during the transition.

## Why

Every ecosystem adapter (OpenAI, Anthropic's OpenAI-compat endpoint,
Together, groq, Mistral, vLLM, llama.cpp, LM Studio) already speaks
OpenAI-wire natively. Sirius's legacy camelCase shape (`topP`,
`maxTokens`, `inputTokens`, `UnifiedContent[]`) forces every adapter
to translate both directions — bug surface and perf hit compound.

Nova keeps OpenAI's shape verbatim: snake_case field names, choices
envelope, `prompt_tokens` / `completion_tokens`, OpenAI-style chunks
on the wire. Extension points (`providerOptions`, `capabilities`)
carry the sirius-specific knobs without mangling the core shape.

Nova also ships a canonical `createOpenAICompatProvider` that covers
every compliant upstream out of the box.

## Repository shape

- `libs/nova/` — canonical contracts + adapters. Seed of the eventual
  standalone Sirius SDK published to npm. Consumed by sirius-gateway,
  llamactl, and embersynth.
- `libs/sirius-core/` — gateway-level types (RoutingDecision,
  provider registry DI) + legacy types kept for migration. Re-exports
  nova under the `nova` namespace.

## Type-by-type migration plan

| Surface | Legacy (sirius-core) | Target (nova) | Status |
|---|---|---|---|
| `UnifiedAiRequest` | camelCase; `requestId` required; flat `stop[]` | snake_case (OpenAI-wire); `requestId` moves to gateway envelope; `stop: string \| string[]`; `providerOptions` bag + `capabilities` tags | pending |
| `UnifiedAiResponse` | flattened `content[]`; required `usage` + `finishReason` | OpenAI `choices[].message`; optional `usage`; `object: 'chat.completion'` literal; `latencyMs` + `provider` optional | pending |
| `UsageMetrics` | `inputTokens/outputTokens/totalTokens` | `prompt_tokens/completion_tokens/total_tokens` (`nova.Usage`) | pending |
| `UnifiedStreamEvent` | high-level deltas (`content_delta`, `tool_call_delta`) | OpenAI chunk envelope + discriminated `chunk/tool_call/error/done` | pending |
| `UnifiedMessage` | camelCase `imageUrl` | OpenAI nested `{ image_url: { url, detail } }`; supports null content + audio + developer role | pending |
| `ModelInfo` | `id`, `provider`, `ownedBy?` | OpenAI shape + capability enum array + optional cost/contextLength | pending |
| `ProviderHealth` | `status: 'healthy'\|'degraded'\|'down'`, `lastChecked: Date` | `state: 'healthy'\|'degraded'\|'unhealthy'\|'unknown'`, `lastChecked: string` (ISO) | pending |
| `UnifiedEmbeddingResponse` | `embeddings: number[][]` | OpenAI list shape `data: [{ object, index, embedding }]` | pending |
| `ModelCapabilityMatrix` | standalone registry with flat booleans | deleted — replaced by `nova.ModelCapability` enum array on `ModelInfo` | pending |
| `AiProvider` interface | every method required | `streamResponse`, `createEmbeddings`, `listModels`, `healthCheck` optional; same signatures | pending |

## Gateway envelope

Sirius-level metadata (request IDs, routing decisions, latency timing)
stays at the gateway layer — it does not pollute the wire shape:

```ts
// libs/sirius-core/src/gateway-envelope.ts  (future)
import type { nova } from '@sirius/core';

export interface GatewayRequest {
  requestId: string;
  request: nova.UnifiedAiRequest;
  metadata?: Record<string, string>;
}

export interface GatewayResponse {
  requestId: string;
  response: nova.UnifiedAiResponse;
  provider: string;
  latencyMs: number;
  routing?: { fallbackChain: string[]; attemptNumber: number };
}
```

Adapters emit `nova.UnifiedAiResponse`; the gateway's controller wraps
in a `GatewayResponse` at serialisation time. Tracing stays in the
envelope, not the wire body.

## Per-provider migration order

Recommended sequence (least-to-most translation work):

1. **provider-openai** — near-passthrough. Nova's OpenAI-compat
   adapter already covers it; this provider can become a thin wrapper
   that uses `nova.createOpenAICompatProvider` plus NestJS DI glue.
2. **provider-anthropic** — Anthropic-native translation to
   nova.UnifiedAi{Request,Response,StreamEvent}. Needs new mapping
   code for message blocks, tool calls, and `finish_reason`.
3. **provider-ollama** — similar shape to OpenAI-compat but diverges
   on model listing. Can reuse the openai-compat adapter with minor
   overrides.

Each provider PR should:

- Adopt nova types in adapter I/O.
- Leave its DI wiring untouched (`@Injectable`, module registration).
- Add a fixture-driven test that covers `createResponse`,
  `streamResponse`, `createEmbeddings` (if supported), `listModels`,
  `healthCheck`.

## Consumer-side migration (for llamactl, embersynth, new projects)

- `import { nova } from '@sirius/core'` for new code.
- Once all internal sirius surfaces have migrated, the legacy
  top-level exports in `sirius-core` will be removed; consumers
  pointing at nova are unaffected.
- llamactl currently carries its own copy at `packages/nova`. Once
  `@sirius/nova` is published (or linked via git), llamactl will
  depend on it directly and delete its copy — no code changes
  needed inside llamactl since the shapes are identical.

## What's NOT changing

- NestJS DI wiring (`@Injectable`, `AI_PROVIDER` symbol, modules).
- Fastify controller surface (`POST /v1/chat/completions`, etc.).
- ProviderRegistry's public API (`register(provider)`, `get(name)`,
  `getAll()`).
- `RoutingDecision` (stays sirius-owned — it's gateway-level metadata,
  not part of the wire contract).
