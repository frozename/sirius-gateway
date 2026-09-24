import { describe, expect, it, mock } from 'bun:test';
import { GatewayService } from '../gateway.service';
import { StreamingObserver } from '@sirius/observability';
import { makeUnifiedRequest } from '../../../../libs/sirius-core/src/__tests__/fixtures';
import type { AiProvider, UnifiedStreamEvent } from '@sirius/core';

/**
 * A1 — stream teardown: when the consumer breaks out of the stream,
 * or when the idle timeout fires, the gateway must call return() on
 * the upstream iterator so cancellation propagates into the provider
 * adapter (and from there into the upstream fetch). Today the
 * iterator is abandoned and the upstream stays open.
 */

function trackedProvider(
  name: string,
  mode: { events: UnifiedStreamEvent[] } | { hang: true },
) {
  const state = { returned: false };
  const provider = {
    name,
    streamResponse: () => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: (): Promise<IteratorResult<UnifiedStreamEvent>> =>
            'hang' in mode
              ? new Promise<IteratorResult<UnifiedStreamEvent>>(() => {})
              : Promise.resolve(
                  i < mode.events.length
                    ? { value: mode.events[i++]!, done: false }
                    : { value: undefined, done: true },
                ),
          return: (): Promise<IteratorResult<UnifiedStreamEvent>> => {
            state.returned = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    }),
    createResponse: async () => {
      throw new Error('unused');
    },
    createEmbeddings: async () => {
      throw new Error('unused');
    },
    listModels: async () => [],
    healthCheck: async () => {
      throw new Error('unused');
    },
  };
  return { provider: provider as unknown as AiProvider, state };
}

function makeGateway(
  provider: AiProvider,
  opts: { idleTimeoutMs?: number; passthroughObserver?: boolean } = {},
) {
  const registry = {
    get: mock((name: string) => (name === provider.name ? provider : undefined)),
    getAll: mock(() => [provider]),
  };
  const routing = {
    route: mock(() => ({
      selectedProvider: provider.name,
      selectedModel: 'm1',
      strategy: 'test',
      fallbackChain: [],
    })),
  };
  const policy = {
    executeWithPolicy: mock((_: string, op: (ctx?: unknown) => unknown) => op()),
    executeStreamWithPolicy: mock((_: string, op: () => unknown) => op()),
  };
  const config = {
    get: mock((key: string, defaultValue: unknown) =>
      key === 'SIRIUS_STREAM_IDLE_TIMEOUT_MS'
        ? (opts.idleTimeoutMs ?? 30)
        : defaultValue,
    ),
  };
  const latency = { record: mock(), getAverageLatency: mock(() => null) };
  const observer = opts.passthroughObserver
    ? ({ observe: (s: unknown) => s } as unknown as StreamingObserver)
    : new StreamingObserver();
  return new GatewayService(
    registry as never,
    routing as never,
    policy as never,
    config as never,
    observer,
    latency as never,
  );
}

describe('GatewayService stream teardown (A1)', () => {
  it('consumer break calls return() and teardown propagates through the observer', async () => {
    const { provider, state } = trackedProvider('p1', {
      events: [
        { type: 'content_delta', delta: 'a' },
        { type: 'content_delta', delta: 'b' },
        { type: 'done', finishReason: 'stop' },
      ],
    });
    const gateway = makeGateway(provider);

    const got: string[] = [];
    for await (const ev of gateway.streamResponse(
      makeUnifiedRequest({ stream: true }),
    )) {
      got.push(ev.type);
      break;
    }

    expect(got).toEqual(['content_delta']);
    expect(state.returned).toBe(true);
  });

  it('idle timeout calls return() on the upstream iterator', async () => {
    const { provider, state } = trackedProvider('p1', { hang: true });
    // Identity observer: a hard-hung upstream leaves a real observer
    // generator suspended at a pending inner next(), which would queue
    // return() behind it — the gateway-level contract under test is
    // that return() is invoked on the iterator it holds.
    const gateway = makeGateway(provider, {
      idleTimeoutMs: 30,
      passthroughObserver: true,
    });

    const events: UnifiedStreamEvent[] = [];
    for await (const ev of gateway.streamResponse(
      makeUnifiedRequest({ stream: true }),
    )) {
      events.push(ev);
    }

    expect(state.returned).toBe(true);
    expect(events.at(-1)?.type).toBe('error');
  });
});
