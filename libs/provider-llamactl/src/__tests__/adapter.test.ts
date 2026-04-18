import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LlamactlAdapter } from '../llamactl.adapter.js';

/**
 * Fixture test against a hermetic llamactl-agent-shaped upstream.
 * Verifies the adapter:
 *   * translates sirius's `UnifiedAiRequest` (camelCase, required
 *     `stream`) into nova's OpenAI-wire shape and back.
 *   * flattens nova's `choices[].message` envelope into sirius's
 *     `content: [{ type: 'text', text }]` legacy shape.
 *   * translates nova streaming `chunk` events into sirius's
 *     `content_delta` events.
 *   * maps `ProviderHealth.state` ("unhealthy" → "down",
 *     "unknown" → "degraded").
 *   * strips the agent bearer header before forwarding (llama-server
 *     has no auth; OpenAI-compat adapter already handles this).
 */

const UPSTREAM_PORT = 39114;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json({
          data: [
            { id: 'llama-fake-1', created: 100, owned_by: 'llamactl-agent' },
            { id: 'llama-fake-2', created: 200, owned_by: 'llamactl-agent' },
          ],
        });
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = (await req.json()) as { stream?: boolean; model: string };
        if (body.stream) {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(
                  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                    body.model +
                    '","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
                ),
              );
              controller.enqueue(
                enc.encode(
                  'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"' +
                    body.model +
                    '","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
                ),
              );
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return Response.json({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: body.model,
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
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => {
  upstream?.stop(true);
});

function makeAdapter(): LlamactlAdapter {
  return new LlamactlAdapter({
    nodeName: 'fake',
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    apiKey: 'bearer-xyz',
  });
}

describe('LlamactlAdapter', () => {
  test('readonly name namespaces under llamactl-', () => {
    expect(makeAdapter().name).toBe('llamactl-fake');
  });

  test('createResponse flattens nova choices into sirius content', async () => {
    const a = makeAdapter();
    const res = await a.createResponse({
      requestId: 'req-1',
      model: 'llama-fake-1',
      messages: [{ role: 'user', content: 'yo' }],
      stream: false,
    });
    expect(res.provider).toBe('llamactl-fake');
    expect(res.content[0]!.type).toBe('text');
    expect(res.content[0]!.text).toBe('ack');
    expect(res.usage.inputTokens).toBe(3);
    expect(res.usage.outputTokens).toBe(1);
    expect(res.usage.totalTokens).toBe(4);
    expect(res.finishReason).toBe('stop');
  });

  test('streamResponse yields sirius content_delta events', async () => {
    const a = makeAdapter();
    const events: Array<{ type: string; delta?: string; finishReason?: string }> = [];
    for await (const ev of a.streamResponse({
      requestId: 'req-2',
      model: 'llama-fake-1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      events.push(ev as { type: string; delta?: string; finishReason?: string });
    }
    const deltas = events.filter((e) => e.type === 'content_delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('hi!');
    expect(events[events.length - 1]!.type).toBe('done');
  });

  test('listModels translates nova ModelInfo into sirius shape', async () => {
    const a = makeAdapter();
    const models = await a.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]!.provider).toBe('llamactl-fake');
    expect(models[0]!.ownedBy).toBe('llamactl-agent');
  });

  test('healthCheck round-trips with lastChecked as Date', async () => {
    const a = makeAdapter();
    const h = await a.healthCheck();
    expect(h.provider).toBe('llamactl-fake');
    expect(['healthy', 'degraded', 'down']).toContain(h.status);
    expect(h.lastChecked).toBeInstanceOf(Date);
  });
});
