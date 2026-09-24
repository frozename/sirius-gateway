import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LlamactlAdapter } from '../llamactl.adapter.js';
import type { UnifiedAiRequest, UnifiedEmbeddingRequest } from '@sirius/core';

/**
 * A1 — caller cancellation must reach the upstream fetch. The adapter
 * threads `ProviderExecutionContext` into nova's openai-compat calls:
 * a caller `signal` aborts the in-flight request (AbortError), a past
 * `deadline` aborts before the request leaves (TimeoutError).
 */

const seen = { chat: 0, embeddings: 0, hang: 0, aborts: 0 };

let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      req.signal.addEventListener('abort', () => {
        seen.aborts++;
      });
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        seen.chat++;
        return Response.json({
          id: 'chatcmpl-x',
          object: 'chat.completion',
          model: 'm',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ack' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      }
      if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
        seen.embeddings++;
        return Response.json({
          object: 'list',
          model: 'emb-m',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        });
      }
      if (url.pathname === '/v1/hang/chat/completions') {
        seen.hang++;
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

function makeAdapter(basePath = 'v1'): LlamactlAdapter {
  return new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${port}/${basePath}`,
    apiKey: 'bearer-xyz',
  });
}

const chatReq: UnifiedAiRequest = {
  requestId: 'req-cancel',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

const embReq: UnifiedEmbeddingRequest = {
  requestId: 'req-cancel-emb',
  model: 'emb-m',
  input: 'hi',
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('LlamactlAdapter cancellation (A1)', () => {
  test('createResponse rejects AbortError on a pre-aborted caller signal; upstream sees nothing', async () => {
    const a = makeAdapter();
    const before = seen.chat;
    const err = await a
      .createResponse(chatReq, { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    expect(seen.chat).toBe(before);
  });

  test('createResponse rejects TimeoutError on a past deadline; upstream sees nothing', async () => {
    const a = makeAdapter();
    const before = seen.chat;
    const err = await a
      .createResponse(chatReq, { deadline: Date.now() - 1000 })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(seen.chat).toBe(before);
  });

  test('createEmbeddings rejects AbortError on a pre-aborted caller signal', async () => {
    const a = makeAdapter();
    const before = seen.embeddings;
    const err = await a
      .createEmbeddings(embReq, { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    expect(seen.embeddings).toBe(before);
  });

  test('createEmbeddings rejects TimeoutError on a past deadline', async () => {
    const a = makeAdapter();
    const before = seen.embeddings;
    const err = await a
      .createEmbeddings(embReq, { deadline: Date.now() - 1000 })
      .catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(seen.embeddings).toBe(before);
  });

  test('a caller abort mid-flight rejects AbortError and the fixture observes the cancel', async () => {
    const a = makeAdapter('v1/hang');
    const controller = new AbortController();
    const hangBefore = seen.hang;
    const abortsBefore = seen.aborts;
    const pending = a.createResponse(chatReq, { signal: controller.signal });
    await until(() => seen.hang > hangBefore);
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    await until(() => seen.aborts > abortsBefore);
  });
});
