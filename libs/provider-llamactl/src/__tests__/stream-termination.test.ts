import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LlamactlAdapter } from '../llamactl.adapter.js';
import type { UnifiedAiRequest, UnifiedStreamEvent } from '@sirius/core';

/**
 * A3 — a truncated upstream stream must never surface as success.
 * nova 0.2.0 tags every `done` event with `completion` provenance;
 * the adapter maps it onto sirius events:
 *
 *   done{completion:'upstream'}            → sirius `done`
 *   done{completion:'eof'|'error'|absent}  → sirius `error` (upstream_eof)
 *   nova `error` event                     → sirius `error`, stream ends
 *   thrown mid-stream transport failure    → sirius `error` EVENT (a
 *     throw would make the policy retry and re-emit partial output)
 *   nova provider without streamResponse   → sirius `error`
 *     (stream_unsupported), not a synthesized done
 *   consumer break                          → upstream request torn down
 */

const enc = new TextEncoder();
const frame = (payload: string) => enc.encode(`data: ${payload}\n\n`);
const chunk = (content: string, finish?: string) =>
  JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [
      {
        index: 0,
        delta: { content },
        ...(finish !== undefined ? { finish_reason: finish } : {}),
      },
    ],
  });

const seen = { cancels: 0 };

let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const mode = url.pathname.split('/')[2]; // /v1/<mode>/chat/completions
      if (!url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 });
      }
      req.signal.addEventListener('abort', () => {
        seen.cancels++;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === 'eof') {
            // Content then a bare transport close — no finish_reason,
            // no [DONE].
            controller.enqueue(frame(chunk('hi')));
            controller.close();
            return;
          }
          if (mode === 'errframe') {
            controller.enqueue(frame(chunk('hi')));
            controller.enqueue(
              frame('{"error":{"message":"boom","type":"server_error"}}'),
            );
            controller.close();
            return;
          }
          if (mode === 'finish-eof') {
            controller.enqueue(frame(chunk('hi', 'stop')));
            controller.close();
            return;
          }
          if (mode === 'reset') {
            controller.enqueue(frame(chunk('hi')));
            setTimeout(() => controller.error(new Error('connection reset')), 20);
            return;
          }
          // 'hang' — first chunk then silence; stays open until the
          // client goes away (cancel/abort observed in `seen.cancels`).
          controller.enqueue(frame(chunk('hi')));
        },
        cancel() {
          seen.cancels++;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  port = server.port;
});

afterAll(() => {
  server?.stop(true);
});

function makeAdapter(mode: string): LlamactlAdapter {
  return new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${port}/v1/${mode}`,
    apiKey: 'bearer-xyz',
  });
}

const req: UnifiedAiRequest = {
  requestId: 'req-stream',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
};

async function collect(a: LlamactlAdapter): Promise<UnifiedStreamEvent[]> {
  const events: UnifiedStreamEvent[] = [];
  for await (const ev of a.streamResponse(req)) events.push(ev);
  return events;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('LlamactlAdapter stream termination (A3)', () => {
  test('EOF without a completion signal yields error upstream_eof and no done', async () => {
    const events = await collect(makeAdapter('eof'));
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'hi' });
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect((last as { code?: string }).code).toBe('upstream_eof');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  test('an upstream SSE error frame yields exactly one error and no done', async () => {
    const events = await collect(makeAdapter('errframe'));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { error: string }).error).toContain('boom');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  test('finish_reason followed by EOF still yields done', async () => {
    const events = await collect(makeAdapter('finish-eof'));
    const last = events.at(-1)!;
    expect(last.type).toBe('done');
    expect((last as { finishReason: string }).finishReason).toBe('stop');
  });

  test('a mid-stream connection reset after output becomes an error event, not a throw', async () => {
    const events = await collect(makeAdapter('reset')); // must not reject
    const last = events.at(-1)!;
    expect(last.type).toBe('error');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  test('consumer break tears the upstream request down', async () => {
    const a = makeAdapter('hang');
    const before = seen.cancels;
    let first: string | undefined;
    for await (const ev of a.streamResponse(req)) {
      first = ev.type;
      break;
    }
    expect(first).toBe('content_delta');
    await until(() => seen.cancels > before);
  });

  test('missing upstream streamResponse yields stream_unsupported, not a synthesized done', async () => {
    const a = makeAdapter('finish-eof');
    // Simulate a nova provider with no streaming surface.
    (a as unknown as { nova: { streamResponse?: unknown } }).nova = {
      streamResponse: undefined,
    };
    const events = await collect(a);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    expect((events[0] as { code?: string }).code).toBe('stream_unsupported');
  });
});
