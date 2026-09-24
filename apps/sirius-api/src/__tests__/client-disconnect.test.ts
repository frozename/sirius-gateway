import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatCompletionsController } from '../controllers/chat-completions.controller';
import { ResponsesController } from '../controllers/responses.controller';
import { EmbeddingsController } from '../controllers/embeddings.controller';
import { GatewayService } from '../gateway.service';
import { PolicyService } from '@sirius/policy';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { StreamingObserver, LatencyTracker } from '@sirius/observability';
import { LlamactlAdapter } from '@sirius/provider-llamactl';
import { UsageRecorderService } from '@sirius/observability';

/**
 * A client that drops the connection mid-request must cancel the
 * in-flight upstream call. Each controller owns an AbortController
 * fired from `res.raw` 'close' and passes the signal into the
 * gateway; the chain lands in the provider's upstream fetch.
 *
 * Bun's node:http shim does not deliver 'close' to a pending
 * ServerResponse, so the disconnect is simulated by emitting 'close'
 * on a fabricated res.raw — the listener, signal plumbing, and
 * upstream cancellation are all real.
 */

const seen = { arrivals: 0, aborts: 0 };
let upstream: ReturnType<typeof Bun.serve>;

const controllers = {} as {
  chat: ChatCompletionsController;
  responses: ResponsesController;
  embeddings: EmbeddingsController;
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (
        (url.pathname === '/v1/chat/completions' ||
          url.pathname === '/v1/embeddings') &&
        req.method === 'POST'
      ) {
        seen.arrivals++;
        req.signal.addEventListener('abort', () => {
          seen.aborts++;
        });
        return new Promise<Response>(() => {});
      }
      return new Response('not found', { status: 404 });
    },
  });

  const adapter = new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
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
    get: mock((_key: string, fallback: unknown) => fallback),
  };
  const latency = { record: mock(), getAverageLatency: mock(() => null) };
  const gateway = new GatewayService(
    registry as never,
    routing as never,
    new PolicyService(config as never),
    config as never,
    new StreamingObserver(),
    latency as unknown as LatencyTracker,
  );
  const compat = new OpenAiCompatService();
  const usageRecorder = { record: mock() } as unknown as UsageRecorderService;
  controllers.chat = new ChatCompletionsController(gateway, compat, usageRecorder);
  controllers.responses = new ResponsesController(gateway, compat, usageRecorder);
  controllers.embeddings = new EmbeddingsController(gateway, compat, usageRecorder);
});

afterAll(() => {
  upstream?.stop(true);
});

type FakeRaw = EventEmitter & {
  writeHead: (...args: unknown[]) => unknown;
  write: (chunk: unknown) => boolean;
  end: (...args: unknown[]) => unknown;
  destroyed: boolean;
};

function fakeReply(): FastifyReply & { raw: FakeRaw } {
  const raw = new EventEmitter() as FakeRaw;
  raw.writeHead = mock(() => raw);
  raw.write = mock(() => true);
  raw.end = mock(() => raw);
  raw.destroyed = false;
  const res = {
    raw,
    header: mock(() => res),
    status: mock(() => res),
    send: mock(() => res),
  };
  return res as unknown as FastifyReply & { raw: FakeRaw };
}

const fakeReq = { id: 'req-disconnect' } as FastifyRequest;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('client disconnect cancels upstream work', () => {
  test('non-streaming chat: connection close aborts the hung upstream fetch', async () => {
    const res = fakeReply();
    const arrivalsBefore = seen.arrivals;
    const abortsBefore = seen.aborts;

    const pending = controllers.chat.chatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      fakeReq,
      res,
    );
    await until(() => seen.arrivals > arrivalsBefore);
    res.raw.emit('close');

    await until(() => seen.aborts > abortsBefore);
    expect(seen.aborts).toBeGreaterThan(abortsBefore);
    await pending;
  });

  test('streaming chat: connection close aborts the hung upstream fetch', async () => {
    const res = fakeReply();
    const arrivalsBefore = seen.arrivals;
    const abortsBefore = seen.aborts;

    const pending = controllers.chat.chatCompletions(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      fakeReq,
      res,
    );
    await until(() => seen.arrivals > arrivalsBefore);
    res.raw.emit('close');

    await until(() => seen.aborts > abortsBefore);
    expect(seen.aborts).toBeGreaterThan(abortsBefore);
    await pending;
  });

  test('responses endpoint: connection close aborts the hung upstream fetch', async () => {
    const res = fakeReply();
    const arrivalsBefore = seen.arrivals;
    const abortsBefore = seen.aborts;

    const pending = controllers.responses.responses(
      { model: 'm', input: 'hi' },
      fakeReq,
      res,
    );
    await until(() => seen.arrivals > arrivalsBefore);
    res.raw.emit('close');

    await until(() => seen.aborts > abortsBefore);
    expect(seen.aborts).toBeGreaterThan(abortsBefore);
    await pending;
  });

  test('embeddings: connection close aborts the hung upstream fetch', async () => {
    const res = fakeReply();
    const arrivalsBefore = seen.arrivals;
    const abortsBefore = seen.aborts;

    const pending = controllers.embeddings.createEmbeddings(
      { model: 'm', input: 'hi' },
      fakeReq,
      res,
    );
    await until(() => seen.arrivals > arrivalsBefore);
    res.raw.emit('close');

    await until(() => seen.aborts > abortsBefore);
    expect(seen.aborts).toBeGreaterThan(abortsBefore);
    await pending;
  });
});
