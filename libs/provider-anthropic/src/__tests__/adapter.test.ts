import { describe, expect, it, afterEach } from 'bun:test';
import { AnthropicAdapter } from '../anthropic.adapter.js';
import {
  mockFetch,
  createJsonResponse,
  createErrorResponse,
  createMockResponse,
  collectAsync,
} from '../../../sirius-core/src/__tests__/test-helpers.js';
import { makeUnifiedRequest, makeEmbeddingRequest, ANTHROPIC_SSE_FIXTURE } from '../../../sirius-core/src/__tests__/fixtures.js';

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
      expect(res.content[0]!.text).toBe('hello');
      
      const headers = Object.fromEntries(new Headers(reqOptions!.headers));
      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('throws on HTTP error', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Invalid request'));
      await expect(adapter.createResponse(makeUnifiedRequest())).rejects.toThrow('Anthropic API error 400: Invalid request');
    });

    it('maps multiple content blocks correctly', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Thinking...' },
          { type: 'tool_use', id: 'tool_1', name: 'search', input: { query: 'test' } }
        ],
        model: 'claude-3-opus',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }));

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(res.content).toHaveLength(2);
      expect(res.content[0]!.text).toBe('Thinking...');
      expect(res.content[1]!.type).toBe('tool_call');
      expect(res.content[1]!.toolCall?.function.name).toBe('search');
    });

    it('handles system messages correctly', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ id: '1', role: 'assistant', content: [], model: 'm', stop_reason: 'end_turn', usage: {} });
      });

      const request = makeUnifiedRequest();
      request.messages.push({ role: 'system', content: 'Be helpful' });
      request.messages.push({ role: 'system', content: 'Be concise' });

      await adapter.createResponse(request);
      expect(sentBody.system).toBe('Be helpful\n\nBe concise');
    });

    it('maps tool choices correctly', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ id: '1', role: 'assistant', content: [], model: 'm', stop_reason: 'end_turn', usage: {} });
      });

      const request = makeUnifiedRequest();
      request.tools = [{ type: 'function', function: { name: 'f1', parameters: {} } }];
      
      // Test 'required' -> 'any'
      request.toolChoice = 'required';
      await adapter.createResponse(request);
      expect(sentBody.tool_choice).toEqual({ type: 'any' });

      // Test specific tool
      request.toolChoice = { type: 'function', function: { name: 'f1' } };
      await adapter.createResponse(request);
      expect(sentBody.tool_choice).toEqual({ type: 'tool', name: 'f1' });
    });

    it('sets x-api-key header', async () => {
      let reqHeaders: Record<string, string> | undefined;
      restoreFetch = mockFetch((req) => {
        reqHeaders = Object.fromEntries(new Headers((req as Request).headers));
        return createJsonResponse({ id: '1', role: 'assistant', content: [], model: 'm', stop_reason: 'end_turn', usage: {} });
      });
      await adapter.createResponse(makeUnifiedRequest());
      expect(reqHeaders!['x-api-key']).toBe('test-key');
    });

    it('sets anthropic-version header', async () => {
      let reqHeaders: Record<string, string> | undefined;
      restoreFetch = mockFetch((req) => {
        reqHeaders = Object.fromEntries(new Headers((req as Request).headers));
        return createJsonResponse({ id: '1', role: 'assistant', content: [], model: 'm', stop_reason: 'end_turn', usage: {} });
      });
      await adapter.createResponse(makeUnifiedRequest());
      expect(reqHeaders!['anthropic-version']).toBe('2023-06-01');
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

    it('handles non-JSON error body in stream', async () => {
      restoreFetch = mockFetch(() => new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ type: 'error', error: 'Anthropic API error 503: Service Unavailable' });
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
      expect(models[0]!.provider).toBe('anthropic');
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
