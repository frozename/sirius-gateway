import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlamactlAdapter } from '../llamactl.adapter.js';
import { nova } from '@sirius/core';
import type { UnifiedAiRequest, UnifiedEmbeddingRequest } from '@sirius/core';

/**
 * A2 — the adapter surfaces the upstream usage observation with its
 * provenance intact under `metadata.usageObservation`, and writes no
 * usage rows itself (recording is the observability layer's job).
 *
 *   - upstream sends no usage block      → observation {source:'unknown'}
 *   - upstream sends partial counts       → missing components stay absent
 *   - concurrent calls                    → each response carries its own
 *                                          observation (keyed by attempt id)
 *   - the adapter                         → never writes to the usage sink
 */

let server: ReturnType<typeof Bun.serve>;
let port = 0;

function chatResponseBody(
  raw: { model: string; usage?: unknown; id?: string },
): Record<string, unknown> {
  return {
    id: raw.id ?? 'chatcmpl-x',
    object: 'chat.completion',
    model: raw.model,
    created: 1,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ack' },
        finish_reason: 'stop',
      },
    ],
    ...(raw.usage !== undefined ? { usage: raw.usage } : {}),
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const mode = url.pathname.split('/')[2]; // /v1/<mode>/chat/completions
      if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
        const body = (await req.json()) as {
          model: string;
          messages?: Array<{ content?: string }>;
        };
        if (mode === 'no-usage') {
          return Response.json(chatResponseBody({ model: body.model }));
        }
        if (mode === 'partial-usage') {
          return Response.json(
            chatResponseBody({ model: body.model, usage: { prompt_tokens: 3 } }),
          );
        }
        if (mode === 'echo') {
          // Usage reflects THIS request so concurrent callers can be
          // told apart: prompt_tokens = message length, id tags it.
          const len = body.messages?.[0]?.content?.length ?? 0;
          return Response.json(
            chatResponseBody({
              model: body.model,
              id: `cmpl-${len}`,
              usage: { prompt_tokens: len, completion_tokens: 1, total_tokens: len + 1 },
            }),
          );
        }
        return Response.json(
          chatResponseBody({
            model: body.model,
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        );
      }
      if (url.pathname.endsWith('/embeddings') && req.method === 'POST') {
        const body = (await req.json()) as { model: string };
        const usage =
          mode === 'no-usage' ? undefined : { prompt_tokens: 2, total_tokens: 2 };
        return Response.json({
          object: 'list',
          model: body.model,
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          ...(usage ? { usage } : {}),
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port!;
});

afterAll(() => {
  server?.stop(true);
});

function makeAdapter(mode = 'full-usage'): LlamactlAdapter {
  return new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${port}/v1/${mode}`,
    apiKey: 'bearer-xyz',
  });
}

const chatReq: UnifiedAiRequest = {
  requestId: 'req-obs',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

const embReq: UnifiedEmbeddingRequest = {
  requestId: 'req-obs-emb',
  model: 'emb-m',
  input: 'hi',
};

function obsOf(res: {
  metadata?: Record<string, unknown> | { usageObservation?: nova.UsageObservationV1 };
}): nova.UsageObservationV1 | undefined {
  return (res.metadata as { usageObservation?: nova.UsageObservationV1 } | undefined)
    ?.usageObservation;
}

describe('LlamactlAdapter usage observations (A2)', () => {
  test('metadata.usageObservation is {source:unknown} when the upstream sends no usage', async () => {
    const res = await makeAdapter('no-usage').createResponse(chatReq);
    const obs = obsOf(res);
    expect(obs?.source).toBe('unknown');
    expect(obs?.input_tokens).toBeUndefined();
    expect(obs?.output_tokens).toBeUndefined();
    expect(obs?.total_tokens).toBeUndefined();
  });

  test('partial upstream counts stay partial — missing components are absent, not zero', async () => {
    const res = await makeAdapter('partial-usage').createResponse(chatReq);
    const obs = obsOf(res);
    expect(obs?.source).toBe('observed');
    expect(obs?.input_tokens).toBe(3);
    expect(obs?.output_tokens).toBeUndefined();
    expect(obs?.total_tokens).toBeUndefined();
  });

  test('fully observed counts carry input/output/total', async () => {
    const res = await makeAdapter('full-usage').createResponse(chatReq);
    const obs = obsOf(res);
    expect(obs?.source).toBe('observed');
    expect(obs?.input_tokens).toBe(3);
    expect(obs?.output_tokens).toBe(1);
    expect(obs?.total_tokens).toBe(4);
  });

  test('concurrent calls keep provenance isolated', async () => {
    const a = makeAdapter('echo');
    // Bun drains each socket's continuation chain atomically, so
    // fixture-side timing alone cannot interleave one call's
    // observation write with another call's adapter-side read. The
    // gate suspends att-long between nova's resolve — where the
    // observation is already written — and the adapter's map read,
    // which is exactly the window a shared-slot carrier
    // misattributes. The cross is deterministic, not racy.
    const inner = (a as unknown as { nova: nova.AiProvider }).nova;
    const orig = inner.createResponse.bind(inner);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    inner.createResponse = (req, ctx) => {
      const p = orig(req, ctx);
      if (ctx?.attemptId === 'att-long') {
        return p.then(async (res) => {
          await gate;
          return res;
        });
      }
      return p;
    };

    const long: UnifiedAiRequest = {
      ...chatReq,
      messages: [{ role: 'user', content: 'x'.repeat(40) }],
    };
    const short: UnifiedAiRequest = {
      ...chatReq,
      messages: [{ role: 'user', content: 'yy' }],
    };
    const pLong = a.createResponse(long, { attemptId: 'att-long' });
    const resShort = await a.createResponse(short, { attemptId: 'att-short' });
    releaseGate();
    const resLong = await pLong;

    const obsLong = obsOf(resLong);
    const obsShort = obsOf(resShort);
    expect(obsLong?.input_tokens).toBe(40);
    expect(obsLong?.upstream_request_id).toBe('cmpl-40');
    expect(obsShort?.input_tokens).toBe(2);
    expect(obsShort?.upstream_request_id).toBe('cmpl-2');
  });

  test('embedding responses carry the observation too', async () => {
    const res = await makeAdapter('full-usage').createEmbeddings(embReq);
    const obs = obsOf(res);
    expect(obs?.source).toBe('observed');
    expect(obs?.input_tokens).toBe(2);
    expect(obs?.total_tokens).toBe(2);
  });

  test('the adapter writes no usage rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sirius-usage-'));
    const prev = process.env.LLAMACTL_USAGE_DIR;
    process.env.LLAMACTL_USAGE_DIR = dir;
    try {
      const a = makeAdapter('full-usage');
      await a.createResponse(chatReq);
      await a.createEmbeddings(embReq);
      const events = [];
      for await (const ev of a.streamResponse({ ...chatReq, stream: true })) {
        events.push(ev);
      }
      expect(readdirSync(dir)).toHaveLength(0);
      expect(existsSync(join(dir, 'usage'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLAMACTL_USAGE_DIR;
      else process.env.LLAMACTL_USAGE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
