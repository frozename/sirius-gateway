import { describe, expect, it } from 'bun:test';
import { nova } from '@sirius/core';
import type { AiProvider } from '@sirius/core';

/**
 * The usage-observation carrier must be declared symmetrically on
 * both non-streaming provider ops — adapters attach
 * `metadata.usageObservation` on chat responses the same way they do
 * on embeddings. Checked at compile time (tsc --noEmit), not runtime:
 * on a bare `UnifiedAiResponse`, `metadata.usageObservation` is just
 * `unknown`; once the carrier is part of the declared return type it
 * resolves to `UsageObservationV1 | undefined`.
 */

type ChatObs = NonNullable<
  Awaited<ReturnType<AiProvider['createResponse']>>['metadata']
>['usageObservation'];
type EmbObs = NonNullable<
  Awaited<ReturnType<AiProvider['createEmbeddings']>>['metadata']
>['usageObservation'];

const _chatObsTyped: ChatObs extends nova.UsageObservationV1 | undefined
  ? true
  : never = true;
const _embObsTyped: EmbObs extends nova.UsageObservationV1 | undefined
  ? true
  : never = true;

describe('observation carrier typing', () => {
  it('declares the carrier on both non-streaming ops', () => {
    expect(_chatObsTyped).toBe(true);
    expect(_embObsTyped).toBe(true);
  });
});
