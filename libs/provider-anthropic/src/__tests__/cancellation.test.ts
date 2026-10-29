import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../anthropic.adapter.js';
import {
  ANTHROPIC_SSE_FIXTURE,
  makeUnifiedRequest,
} from '../../../sirius-core/src/__tests__/fixtures.js';

/**
 * #16: the caller's AbortSignal must reach the upstream fetch. The fixture
 * server answers at once, except under /hold/, where it keeps the request
 * open and counts the client's disconnect. A held request is answered only
 * if its abort never reached the server, so a missing signal makes the call
 * resolve (an assertion failure) instead of hanging the test.
 */

const seen = { hits: 0, aborts: 0 };
const held: (() => void)[] = [];

let server: ReturnType<typeof Bun.serve>;
let port = 0;

function cannedReply(stream: boolean): Response {
  if (stream) {
    return new Response(ANTHROPIC_SSE_FIXTURE, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  return Response.json({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const sent = (await req.json()) as { stream?: unknown };
      const reply = cannedReply(sent.stream === true);
      if (!url.pathname.startsWith('/hold/')) {
        seen.hits++;
        return reply;
      }
      // Count the hit only after the abort listener is in place, so a test
      // that waits for the hit and then aborts can never miss the event.
      req.signal.addEventListener('abort', () => {
        seen.aborts++;
      });
      seen.hits++;
      return new Promise<Response>((resolve) => {
        held.push(() => {
          resolve(reply);
        });
      });
    },
  });
  port = server.port!;
});

afterAll(() => {
  held.length = 0;
  server?.stop(true);
});

function makeAdapter(prefix = ''): AnthropicAdapter {
  // The fixture server never reads the x-api-key header.
  return new AnthropicAdapter('unused', `http://127.0.0.1:${port}${prefix}`);
}

/** 'resolved', or 'rejected:<error name>'. */
function settle(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'resolved',
    (err: unknown) => `rejected:${(err as DOMException).name}`,
  );
}

/** Polls cond every 10 ms; false once ms have passed without it holding. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** Answers the held requests only if their abort never reached the server. */
function finishHeld(upstreamCancelled: boolean): void {
  const pending = held.splice(0);
  if (upstreamCancelled) return;
  for (const release of pending) {
    release();
  }
}

describe('AnthropicAdapter cancellation (#16)', () => {
  it('createResponse without a context still completes', async () => {
    const outcome = await settle(makeAdapter().createResponse(makeUnifiedRequest()));
    expect(outcome).toBe('resolved');
  });

  it('createResponse rejects AbortError on a pre-aborted signal; upstream sees nothing', async () => {
    const hitsBefore = seen.hits;
    const outcome = await settle(
      makeAdapter().createResponse(makeUnifiedRequest(), {
        signal: AbortSignal.abort(),
      }),
    );
    expect(outcome).toBe('rejected:AbortError');
    expect(seen.hits).toBe(hitsBefore);
  });

  it('createResponse: a mid-flight abort rejects AbortError and cancels the upstream request', async () => {
    const controller = new AbortController();
    const hitsBefore = seen.hits;
    const abortsBefore = seen.aborts;
    const outcome = settle(
      makeAdapter('/hold').createResponse(makeUnifiedRequest(), {
        signal: controller.signal,
      }),
    );
    expect(await waitFor(() => seen.hits > hitsBefore)).toBe(true);
    controller.abort();
    const upstreamCancelled = await waitFor(() => seen.aborts > abortsBefore);
    finishHeld(upstreamCancelled);
    expect(await outcome).toBe('rejected:AbortError');
    expect(upstreamCancelled).toBe(true);
  });

  it('streamResponse: a mid-flight abort rejects the first next() with AbortError and cancels the upstream request', async () => {
    const controller = new AbortController();
    const hitsBefore = seen.hits;
    const abortsBefore = seen.aborts;
    const stream = makeAdapter('/hold').streamResponse(
      makeUnifiedRequest({ stream: true }),
      controller.signal,
    );
    const outcome = settle(stream[Symbol.asyncIterator]().next());
    expect(await waitFor(() => seen.hits > hitsBefore)).toBe(true);
    controller.abort();
    const upstreamCancelled = await waitFor(() => seen.aborts > abortsBefore);
    finishHeld(upstreamCancelled);
    expect(await outcome).toBe('rejected:AbortError');
    expect(upstreamCancelled).toBe(true);
  });
});
