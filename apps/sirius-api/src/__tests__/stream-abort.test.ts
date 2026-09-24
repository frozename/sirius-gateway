import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { GatewayService } from '../gateway.service';
import { PolicyService } from '@sirius/policy';
import { StreamingObserver, LatencyTracker } from '@sirius/observability';
import { LlamactlAdapter } from '@sirius/provider-llamactl';
import { makeUnifiedRequest } from '../../../../libs/sirius-core/src/__tests__/fixtures';
import type { UnifiedStreamEvent } from '@sirius/core';

/**
 * Stream teardown must cancel the upstream fetch, not just the local
 * iterator. `iterator.return()` on a hung stream queues behind the
 * pending `next()` and never reaches the adapter — the gateway must
 * carry an AbortSignal into `provider.streamResponse` and fire it on
 * every teardown path (idle timeout, consumer break, mid-stream
 * failure). These tests run the REAL LlamactlAdapter + StreamingObserver
 * + PolicyService against a hung Bun.serve upstream and assert the
 * fixture observes the socket abort.
 */

const seen = { arrivals: 0, aborts: 0 };
let server: ReturnType<typeof Bun.serve>;
let port = 0;

const SSE_CHUNK =
  'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
        seen.arrivals++;
        req.signal.addEventListener('abort', () => {
          seen.aborts++;
        });
        if (url.pathname.startsWith('/v1/one-then-hang/')) {
          // One SSE chunk, then the stream stays open forever — the
          // consumer gets an event to break on, the upstream pends.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(SSE_CHUNK));
            },
          });
          return new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Promise<Response>(() => {});
      }
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port!;
});

afterAll(() => {
  server?.stop(true);
});

function makeGateway(mode: 'hang' | 'one-then-hang', idleTimeoutMs = 60) {
  const adapter = new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${port}/v1/${mode}`,
    apiKey: 'bearer-xyz',
  });
  const registry = {
    get: mock((name: string) => (name === adapter.name ? adapter : undefined)),
    getAll: mock(() => [adapter]),
  };
  const routing = {
    route: mock(() => ({
      selectedProvider: adapter.name,
      selectedModel: 'm',
      strategy: 'test',
      fallbackChain: [],
    })),
  };
  const config = {
    get: mock((key: string, defaultValue: unknown) =>
      key === 'SIRIUS_STREAM_IDLE_TIMEOUT_MS' ? idleTimeoutMs : defaultValue,
    ),
  };
  const latency = { record: mock(), getAverageLatency: mock(() => null) };
  const policy = new PolicyService(config as never);
  return new GatewayService(
    registry as never,
    routing as never,
    policy,
    config as never,
    new StreamingObserver(),
    latency as unknown as LatencyTracker,
  );
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('GatewayService stream abort propagation', () => {
  test('idle timeout cancels the upstream fetch through the real adapter', async () => {
    const gateway = makeGateway('hang');
    const arrivalsBefore = seen.arrivals;
    const abortsBefore = seen.aborts;

    const events: UnifiedStreamEvent[] = [];
    for await (const ev of gateway.streamResponse(
      makeUnifiedRequest({ stream: true }),
    )) {
      events.push(ev);
    }

    // The upstream saw the request and observed the client-side abort
    // — return() alone would leave the fetch pending forever.
    expect(seen.arrivals).toBeGreaterThan(arrivalsBefore);
    await until(() => seen.aborts > abortsBefore);
    expect(events.at(-1)?.type).toBe('error');
  });

  test('consumer break cancels the upstream fetch through the real adapter', async () => {
    const gateway = makeGateway('one-then-hang');
    const abortsBefore = seen.aborts;

    const got: string[] = [];
    for await (const ev of gateway.streamResponse(
      makeUnifiedRequest({ stream: true }),
    )) {
      got.push(ev.type);
      break;
    }

    expect(got).toEqual(['content_delta']);
    await until(() => seen.aborts > abortsBefore);
  });
});
