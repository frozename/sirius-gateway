import { describe, expect, it, afterEach } from 'bun:test';
import { OpenAiAdapter } from '../openai.adapter.js';
import {
  mockFetch,
  createJsonResponse,
  createErrorResponse,
  createMockResponse,
  collectAsync,
} from '../../../sirius-core/src/__tests__/test-helpers.js';
import { makeUnifiedRequest, makeEmbeddingRequest, OPENAI_SSE_FIXTURE } from '../../../sirius-core/src/__tests__/fixtures.js';

describe('OpenAiAdapter', () => {
  const adapter = new OpenAiAdapter('test-key');
  let restoreFetch: () => void;

  afterEach(() => {
    if (restoreFetch) restoreFetch();
  });

  describe('isConfigured', () => {
    it('returns true when key is non-empty', () => {
      expect(new OpenAiAdapter('key').isConfigured()).toBe(true);
    });

    it('returns false when key is empty', () => {
      expect(new OpenAiAdapter('').isConfigured()).toBe(false);
    });
  });

  describe('createResponse', () => {
    it('calls API with correct URL and headers and maps response', async () => {
      let reqOptions: RequestInit | undefined;
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        reqOptions = { headers: (req as Request).headers, method: (req as Request).method };
        reqUrl = (req as Request).url;
        return createJsonResponse({
          id: 'chatcmpl-123',
          model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      });

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(reqUrl).toBe('https://api.openai.com/v1/chat/completions');
      expect(res.provider).toBe('openai');
      expect(res.content[0].text).toBe('hello');
      
      const headers = Object.fromEntries(new Headers(reqOptions!.headers));
      expect(headers['authorization']).toBe('Bearer test-key');
      expect(headers['content-type']).toBe('application/json');
    });

    it('throws on HTTP error with JSON message', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Invalid request'));
      await expect(adapter.createResponse(makeUnifiedRequest())).rejects.toThrow('OpenAI API error 400: Invalid request');
    });

    it("throws with statusText when error body isn't JSON", async () => {
      restoreFetch = mockFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));
      await expect(adapter.createResponse(makeUnifiedRequest())).rejects.toThrow('OpenAI API error 404: Not Found');
    });

    it('handles multiple choices by taking the first one', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({
        id: 'chatcmpl-123',
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'first' }, finish_reason: 'stop' },
          { index: 1, message: { role: 'assistant', content: 'second' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(res.content[0].text).toBe('first');
    });

    it('maps tool calls to unified content', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({
        id: 'chatcmpl-123',
        model: 'gpt-4o',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"location":"London"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }],
      }));

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(res.content[0].type).toBe('tool_call');
      expect(res.content[0].toolCall?.function.name).toBe('get_weather');
      expect(res.finishReason).toBe('tool_calls');
    });

    it('delegates request mapping to toOpenAiRequest', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({
          id: '1',
          model: 'gpt-4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      });
      await adapter.createResponse(makeUnifiedRequest());
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.model).toBe('gpt-4o');
      // OpenAI format uses 'messages', unified format might use 'content' blocks in a different way
      expect(sentBody.messages[0].role).toBe('user');
    });
  });

  describe('streamResponse', () => {
    it('sends stream:true and yields events via parser', async () => {
      let reqOptions: RequestInit | undefined;
      restoreFetch = mockFetch(async (req) => {
        reqOptions = { method: (req as Request).method };
        const bodyText = await (req as Request).clone().text();
        const bodyObj = JSON.parse(bodyText);
        expect(bodyObj.stream).toBe(true);
        return createMockResponse(OPENAI_SSE_FIXTURE, 200, { 'Content-Type': 'text/event-stream' });
      });

      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('content_delta');
    });

    it('yields error event on HTTP error (NOT throw) with JSON message', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Invalid request'));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ type: 'error', error: 'OpenAI API error 400: Invalid request' });
    });

    it('handles non-JSON error body in stream', async () => {
      restoreFetch = mockFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ type: 'error', error: 'OpenAI API error 404: Not Found' });
    });

    it('yields tool call deltas, usage, and finish reason', async () => {
      const toolStream = 
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f1","arguments":""}}]},"finish_reason":null}]}\n' +
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}\n' +
        'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n' +
        'data: [DONE]\n';
      
      restoreFetch = mockFetch(() => createMockResponse(toolStream, 200, { 'Content-Type': 'text/event-stream' }));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      
      const tcDeltas = events.filter(e => e.type === 'tool_call_delta');
      expect(tcDeltas.length).toBe(2);
      expect(tcDeltas[0].id).toBe('c1');
      expect(tcDeltas[0].name).toBe('f1');
      
      const usageEvent = events.find(e => e.type === 'usage');
      expect(usageEvent?.usage?.totalTokens).toBe(15);
      
      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent?.finishReason).toBe('stop');
    });
  });

  describe('createEmbeddings', () => {
    it('calls URL correctly and maps response', async () => {
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        reqUrl = (req as Request).url;
        return createJsonResponse({
          object: 'list',
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      });

      const res = await adapter.createEmbeddings(makeEmbeddingRequest());
      expect(reqUrl).toBe('https://api.openai.com/v1/embeddings');
      expect(res.provider).toBe('openai');
      expect(res.embeddings[0]).toEqual([0.1, 0.2]);
    });

    it('throws on error', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(400, 'Bad request'));
      await expect(adapter.createEmbeddings(makeEmbeddingRequest())).rejects.toThrow('OpenAI Embeddings API error 400: Bad request');
    });

    it('serializes embedding request body correctly', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 5, total_tokens: 5 },
        });
      });
      await adapter.createEmbeddings(makeEmbeddingRequest());
      expect(sentBody.input).toBeDefined();
      expect(sentBody.model).toBe('text-embedding-3-small');
    });
  });

  describe('listModels', () => {
    it('calls URL GET and maps data to ModelInfo[]', async () => {
      let method: string | undefined;
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        method = (req as Request).method;
        reqUrl = (req as Request).url;
        return createJsonResponse({
          data: [{ id: 'gpt-4o', created: 123456, owned_by: 'openai' }]
        });
      });

      const models = await adapter.listModels();
      expect(reqUrl).toBe('https://api.openai.com/v1/models');
      expect(method).toBe('GET');
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('gpt-4o');
      expect(models[0].provider).toBe('openai');
    });

    it('throws on error', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(401, 'Unauthorized'));
      await expect(adapter.listModels()).rejects.toThrow('OpenAI Models API error 401: Unauthorized');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy+latency on success', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({ data: [] }));
      const health = await adapter.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.provider).toBe('openai');
    });

    it('returns down+error on failure', async () => {
      restoreFetch = mockFetch(() => createErrorResponse(500, 'Server error'));
      const health = await adapter.healthCheck();
      expect(health.status).toBe('down');
      expect(health.error).toContain('OpenAI Models API error 500: Server error');
    });
  });
});
