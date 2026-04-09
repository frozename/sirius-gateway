import { describe, expect, it, afterEach } from 'bun:test';
import { AnthropicAdapter } from '../anthropic.adapter.js';
import {
  mockFetch,
  createJsonResponse,
  createErrorResponse,
  createMockResponse,
  collectAsync,
} from '@sirius/core/__tests__/test-helpers.js';
import { makeUnifiedRequest, makeEmbeddingRequest, ANTHROPIC_SSE_FIXTURE } from '@sirius/core/__tests__/fixtures.js';

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter('test-key');
  let restoreFetch: () => void;

  afterEach(() => {
    if (restoreFetch) restoreFetch();
  });

  describe('isConfigured', () => {
    it('returns true based on key', () => {
      expect(new AnthropicAdapter('key').isConfigured()).toBe(true);
    });

    it('returns false based on empty key', () => {
      expect(new AnthropicAdapter('').isConfigured()).toBe(false);
    });
  });

  describe('createResponse', () => {
    it('calls API with correct URL and headers and delegates correctly', async () => {
      let reqOptions: RequestInit | undefined;
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        reqOptions = { headers: (req as Request).headers, method: (req as Request).method };
        reqUrl = (req as Request).url;
        return createJsonResponse({
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          model: 'claude-3-opus-20240229',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      });

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(reqUrl).toBe('https://api.anthropic.com/v1/messages');
      expect(res.provider).toBe('anthropic');
      expect(res.content[0].text).toBe('hello');
      
      const headers = Object.fromEntries(new Headers(reqOptions!.headers));
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('throws on HTTP error', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Invalid request'));
      await expect(adapter.createResponse(makeUnifiedRequest())).rejects.toThrow('Anthropic API error 400: Invalid request');
    });
  });

  describe('streamResponse', () => {
    it('sends stream:true and delegates to parser', async () => {
      restoreFetch = mockFetch(async (req) => {
        const bodyText = await (req as Request).clone().text();
        const bodyObj = JSON.parse(bodyText);
        expect(bodyObj.stream).toBe(true);
        return createMockResponse(ANTHROPIC_SSE_FIXTURE, 200, { 'Content-Type': 'text/event-stream' });
      });

      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'content_delta')).toBe(true);
    });

    it('yields error event on HTTP error', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Invalid request'));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ type: 'error', error: 'Anthropic API error 400: Invalid request' });
    });
  });

  describe('createEmbeddings', () => {
    it('throws Anthropic does not support embeddings', async () => {
      await expect(adapter.createEmbeddings(makeEmbeddingRequest())).rejects.toThrow('Anthropic does not support embeddings. Use a different provider.');
    });
  });

  describe('listModels', () => {
    it('returns KNOWN_MODELS (no HTTP call)', async () => {
      let called = false;
      restoreFetch = mockFetch(() => { called = true; return createJsonResponse({}); });
      
      const models = await adapter.listModels();
      expect(called).toBe(false);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].provider).toBe('anthropic');
    });
  });

  describe('healthCheck', () => {
    it('returns down when not configured', async () => {
      const emptyAdapter = new AnthropicAdapter('');
      const health = await emptyAdapter.healthCheck();
      expect(health.status).toBe('down');
      expect(health.error).toBe('API key not configured');
    });

    it('returns healthy when configured (no HTTP call)', async () => {
      let called = false;
      restoreFetch = mockFetch(() => { called = true; return createJsonResponse({}); });

      const health = await adapter.healthCheck();
      expect(called).toBe(false);
      expect(health.status).toBe('healthy');
      expect(health.provider).toBe('anthropic');
    });
  });
});
