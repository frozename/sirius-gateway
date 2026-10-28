import { describe, expect, it, mock, spyOn } from 'bun:test';
import { GatewayService } from '../gateway.service';
import { PolicyService } from '@sirius/policy';
import type { UnifiedStreamEvent } from '@sirius/core';
import {
  makeStreamEvent,
  makeUnifiedRequest,
  MockProvider,
} from '../../../../libs/sirius-core/src/__tests__/fixtures';

/**
 * #7: once a stream attempt has yielded output to the client, neither
 * the policy retry nor the gateway fallback may start another attempt,
 * or the client receives replayed or spliced content. The failure
 * surfaces as one error event after the partial output instead.
 */

function partialThenFail(name: string, calls: { count: number }): MockProvider {
  const provider = new MockProvider(name);
  provider.streamResponse = async function* (): AsyncIterable<UnifiedStreamEvent> {
    calls.count++;
    yield makeStreamEvent({ type: 'content_delta', delta: 'Hel' });
    throw new Error('p1 reset');
  };
  return provider;
}

function partialThenStall(name: string): MockProvider {
  const provider = new MockProvider(name);
  provider.streamResponse = async function* (): AsyncIterable<UnifiedStreamEvent> {
    yield makeStreamEvent({ type: 'content_delta', delta: 'Hel' });
    await new Promise<never>(() => {});
  };
  return provider;
}

function fallbackProvider(): MockProvider {
  const provider = new MockProvider('p2');
  provider.setStream([
    makeStreamEvent({ type: 'content_delta', delta: 'from p2' }),
    makeStreamEvent({ type: 'done' }),
  ]);
  return provider;
}

function makeGateway(
  p1: MockProvider,
  p2: MockProvider,
  opts: { idleTimeoutMs?: number; realPolicy?: boolean } = {},
): GatewayService {
  const registry = {
    get: mock((name: string) => (name === 'p1' ? p1 : name === 'p2' ? p2 : undefined)),
    getAll: mock(() => [p1, p2]),
  };
  const routing = {
    route: mock(() => ({
      selectedProvider: 'p1',
      selectedModel: 'm1',
      strategy: 'test',
      fallbackChain: ['p2/m1'],
    })),
  };
  const config = {
    get: mock((key: string, defaultValue: unknown) => {
      if (key === 'SIRIUS_STREAM_IDLE_TIMEOUT_MS') return opts.idleTimeoutMs ?? 2000;
      if (key === 'SIRIUS_RETRY_MAX_ATTEMPTS') return 2;
      if (key === 'SIRIUS_RETRY_BASE_DELAY_MS') return 1;
      return defaultValue;
    }),
  };
  const policy = opts.realPolicy
    ? new PolicyService(config as never)
    : {
        executeWithPolicy: mock((_: string, op: () => unknown) => op()),
        executeStreamWithPolicy: mock((_: string, op: () => unknown) => op()),
      };
  const observer = { observe: (s: unknown) => s };
  const latency = { record: mock(), getAverageLatency: mock(() => null) };
  return new GatewayService(
    registry as never,
    routing as never,
    policy as never,
    config as never,
    observer as never,
    latency as never,
  );
}

async function collect(gateway: GatewayService): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const event of gateway.streamResponse(makeUnifiedRequest({ stream: true }))) {
    events.push(event);
  }
  return events;
}

describe('GatewayService partial-output streams (#7)', () => {
  it('does not fall back after a mid-stream provider failure', async () => {
    const calls = { count: 0 };
    const p2 = fallbackProvider();
    const p2Stream = spyOn(p2, 'streamResponse');
    const gateway = makeGateway(partialThenFail('p1', calls), p2);

    const events = await collect(gateway);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'error', error: 'p1 reset' },
    ]);
    expect(calls.count).toBe(1);
    expect(p2Stream).not.toHaveBeenCalled();
  });

  it('does not fall back after an idle timeout that follows output', async () => {
    const p2 = fallbackProvider();
    const p2Stream = spyOn(p2, 'streamResponse');
    const gateway = makeGateway(partialThenStall('p1'), p2, { idleTimeoutMs: 30 });

    const events = await collect(gateway);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'error', error: 'Stream idle timeout' },
    ]);
    expect(p2Stream).not.toHaveBeenCalled();
  });

  it('still falls back when the primary fails before any output', async () => {
    const p1 = new MockProvider('p1');
    p1.setError(new Error('p1 down'));
    const p2 = fallbackProvider();
    const p2Stream = spyOn(p2, 'streamResponse');
    const gateway = makeGateway(p1, p2);

    const events = await collect(gateway);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'from p2' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(p2Stream).toHaveBeenCalledTimes(1);
  });

  it('with the real PolicyService, sends the partial output once and then an error', async () => {
    const calls = { count: 0 };
    const p2 = fallbackProvider();
    const p2Stream = spyOn(p2, 'streamResponse');
    const gateway = makeGateway(partialThenFail('p1', calls), p2, { realPolicy: true });

    const events = await collect(gateway);

    expect(events).toEqual([
      { type: 'content_delta', delta: 'Hel' },
      { type: 'error', error: 'p1 reset' },
    ]);
    expect(calls.count).toBe(1);
    expect(p2Stream).not.toHaveBeenCalled();
  });
});
