import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSiriusMcpServer } from '../src/server.js';

/**
 * Coverage for `sirius.chat` + `sirius.embed`. Both POST to the
 * existing sirius-api routes; here we stub `globalThis.fetch` so the
 * tool surface is exercised end-to-end without a live gateway. The
 * stub also lets us assert the outbound URL + body shape (stream
 * coercion in particular).
 */

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let runtimeDir = '';
let auditDir = '';
let captured: CapturedCall[] = [];

function stubFetch(response: { status: number; body: unknown }): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), init });
    const text = typeof response.body === 'string'
      ? response.body
      : JSON.stringify(response.body);
    return new Response(text, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'sirius-mcp-chat-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'sirius-mcp-chat-audit-'));
  captured = [];
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    LLAMACTL_PROVIDERS_FILE: join(runtimeDir, 'sirius-providers.yaml'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    SIRIUS_URL: 'http://127.0.0.1:3000',
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

async function connected() {
  const server = buildSiriusMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

describe('@sirius/mcp chat + embed', () => {
  test('sirius.chat forwards to /v1/chat/completions + wraps the response', async () => {
    const mockResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      created: 1713600000,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello back' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    stubFetch({ status: 200, body: mockResponse });
    const client = await connected();

    const result = await client.callTool({
      name: 'sirius.chat',
      arguments: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    const envelope = JSON.parse(textOf(result)) as {
      ok: boolean;
      status: number;
      body: typeof mockResponse;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe(200);
    expect(envelope.body.id).toBe('chatcmpl-1');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://127.0.0.1:3000/v1/chat/completions');
    expect(captured[0]!.init?.method).toBe('POST');
    const sent = JSON.parse(String(captured[0]!.init?.body));
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe('gpt-4o-mini');
  });

  test('sirius.chat coerces stream:true to stream:false on the upstream POST', async () => {
    stubFetch({ status: 200, body: { id: 'x', object: 'chat.completion', model: 'm', created: 0, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } });
    const client = await connected();

    await client.callTool({
      name: 'sirius.chat',
      arguments: {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(captured).toHaveLength(1);
    const sent = JSON.parse(String(captured[0]!.init?.body));
    expect(sent.stream).toBe(false);
  });

  test('sirius.embed forwards to /v1/embeddings + wraps the response', async () => {
    const mockResponse = {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    };
    stubFetch({ status: 200, body: mockResponse });
    const client = await connected();

    const result = await client.callTool({
      name: 'sirius.embed',
      arguments: {
        model: 'text-embedding-3-small',
        input: 'the quick brown fox',
      },
    });
    const envelope = JSON.parse(textOf(result)) as {
      ok: boolean;
      status: number;
      body: typeof mockResponse;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.body.data[0]!.embedding).toEqual([0.1, 0.2, 0.3]);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('http://127.0.0.1:3000/v1/embeddings');
    expect(captured[0]!.init?.method).toBe('POST');
    const sent = JSON.parse(String(captured[0]!.init?.body));
    expect(sent.model).toBe('text-embedding-3-small');
    expect(sent.input).toBe('the quick brown fox');
  });

  test('sirius.chat surfaces upstream 500 as ok:false in the envelope without rejecting', async () => {
    stubFetch({ status: 500, body: { error: { message: 'internal' } } });
    const client = await connected();

    const result = await client.callTool({
      name: 'sirius.chat',
      arguments: {
        model: 'm',
        messages: [{ role: 'user', content: 'boom' }],
      },
    });
    const envelope = JSON.parse(textOf(result)) as {
      ok: boolean;
      status: number;
      body: { error: { message: string } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe(500);
    expect(envelope.body.error.message).toBe('internal');
  });
});
