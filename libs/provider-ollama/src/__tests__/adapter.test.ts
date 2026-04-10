import { describe, expect, it, afterEach } from 'bun:test';
import { OllamaAdapter } from '../ollama.adapter.js';
import {
  mockFetch,
  createJsonResponse,
  createMockResponse,
  collectAsync,
} from '../../../sirius-core/src/__tests__/test-helpers.js';
import { makeUnifiedRequest, makeEmbeddingRequest, OLLAMA_NDJSON_FIXTURE } from '../../../sirius-core/src/__tests__/fixtures.js';

describe('OllamaAdapter', () => {
  const adapter = new OllamaAdapter();
  let restoreFetch: () => void;

  afterEach(() => {
    if (restoreFetch) restoreFetch();
  });

  describe('isConfigured', () => {
    it('is always true', () => {
      expect(adapter.isConfigured()).toBe(true);
    });
  });

  describe('createResponse', () => {
    it('calls API with URL, Content-Type only, delegates', async () => {
      let reqOptions: RequestInit | undefined;
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        reqOptions = { headers: (req as Request).headers, method: (req as Request).method };
        reqUrl = (req as Request).url;
        return createJsonResponse({
          model: 'llama2',
          created_at: '2023-08-04T19:22:45.499Z',
          message: { role: 'assistant', content: 'hello' },
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        });
      });

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(reqUrl).toBe('http://localhost:11434/api/chat');
      expect(res.provider).toBe('ollama');
      expect(res.content[0].text).toBe('hello');
      
      const headers = Object.fromEntries(new Headers(reqOptions!.headers));
      expect(headers['content-type']).toBe('application/json');
      expect(headers['authorization']).toBeUndefined();
    });

    it('throws with res.text() error', async () => {
      restoreFetch = mockFetch(() => createMockResponse('Some plain text error', 500));
      await expect(adapter.createResponse(makeUnifiedRequest())).rejects.toThrow('Ollama API error 500: Some plain text error');
    });

    it('maps tool calls to unified content', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({
        model: 'llama3',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            function: { name: 'get_weather', arguments: { location: 'London' } }
          }]
        },
        done: true,
      }));

      const res = await adapter.createResponse(makeUnifiedRequest());
      expect(res.content[0].type).toBe('tool_call');
      expect(res.content[0].toolCall?.function.name).toBe('get_weather');
      expect(res.finishReason).toBe('tool_calls');
    });

    it('maps generation options correctly', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ model: 'm', message: { role: 'a' }, done: true });
      });

      const request = makeUnifiedRequest();
      request.temperature = 0.5;
      request.maxTokens = 100;
      request.stop = ['STOP'];

      await adapter.createResponse(request);
      expect(sentBody.options.temperature).toBe(0.5);
      expect(sentBody.options.num_predict).toBe(100);
      expect(sentBody.options.stop).toEqual(['STOP']);
    });

    it('handles multi-part image content', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ model: 'm', message: { role: 'a' }, done: true });
      });

      const request = makeUnifiedRequest();
      request.messages[0].content = [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', imageUrl: 'base64-data' }
      ];

      await adapter.createResponse(request);
      expect(sentBody.messages[0].content).toBe('What is this?');
      expect(sentBody.messages[0].images).toEqual(['base64-data']);
    });

    it('delegates request mapping to toOllamaRequest', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ message: { role: 'assistant', content: 'hi' }, model: 'llama3', done: true });
      });
      await adapter.createResponse({ ...makeUnifiedRequest(), model: 'llama3' });
      expect(sentBody.model).toBe('llama3');
      expect(sentBody.messages).toBeDefined();
      expect(sentBody.stream).toBe(false);
    });
  });

  describe('streamResponse', () => {
    it('sends stream:true, delegates to parser', async () => {
      restoreFetch = mockFetch(async (req) => {
        const bodyText = await (req as Request).clone().text();
        const bodyObj = JSON.parse(bodyText);
        expect(bodyObj.stream).toBe(true);
        return createMockResponse(OLLAMA_NDJSON_FIXTURE, 200, { 'Content-Type': 'application/x-ndjson' });
      });

      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'content_delta')).toBe(true);
    });

    it('yields error with res.text()', async () => {
      restoreFetch = mockFetch(() => createMockResponse('Bad input', 400));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ type: 'error', error: 'Ollama API error 400: Bad input' });
    });

    it('yields tool call deltas in stream', async () => {
      const toolStream = 
        '{"model":"llama3","message":{"role":"assistant","tool_calls":[{"function":{"name":"f1","arguments":{"a":1}}}]},"done":false}\n' +
        '{"model":"llama3","done":true}\n';
      
      restoreFetch = mockFetch(() => createMockResponse(toolStream, 200, { 'Content-Type': 'application/x-ndjson' }));
      const events = await collectAsync(adapter.streamResponse(makeUnifiedRequest()));
      
      const tcDelta = events.find(e => e.type === 'tool_call_delta');
      expect(tcDelta).toBeDefined();
      expect(tcDelta?.name).toBe('f1');
      expect(tcDelta?.argumentsDelta).toBe('{"a":1}');
    });
  });

  describe('createEmbeddings', () => {
    it('calls URL, maps correctly', async () => {
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        reqUrl = (req as Request).url;
        return createJsonResponse({
          embeddings: [[0.1, 0.2, 0.3]]
        });
      });

      const res = await adapter.createEmbeddings(makeEmbeddingRequest());
      expect(reqUrl).toBe('http://localhost:11434/api/embed');
      expect(res.provider).toBe('ollama');
      expect(res.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    });

    it('throws on error', async () => {
      restoreFetch = mockFetch(() => createMockResponse('Model not found', 404));
      await expect(adapter.createEmbeddings(makeEmbeddingRequest())).rejects.toThrow('Ollama Embed API error 404: Model not found');
    });

    it('serializes embedding request body correctly', async () => {
      let sentBody: any;
      restoreFetch = mockFetch(async (req) => {
        sentBody = JSON.parse(await (req as Request).clone().text());
        return createJsonResponse({ embeddings: [[0.1, 0.2]], model: 'llama3' });
      });
      await adapter.createEmbeddings(makeEmbeddingRequest());
      expect(sentBody.model).toBeDefined();
      expect(sentBody.input).toBeDefined();
    });
  });

  describe('listModels', () => {
    it('calls URL GET, maps models[].name with ownedBy=local', async () => {
      let method: string | undefined;
      let reqUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        method = (req as Request).method;
        reqUrl = (req as Request).url;
        return createJsonResponse({
          models: [{ name: 'llama2' }, { name: 'mistral' }]
        });
      });

      const models = await adapter.listModels();
      expect(reqUrl).toBe('http://localhost:11434/api/tags');
      expect(method).toBe('GET');
      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('llama2');
      expect(models[0].ownedBy).toBe('local');
    });

    it('handles empty models list', async () => {
      restoreFetch = mockFetch(() => createJsonResponse({ models: [] }));
      const models = await adapter.listModels();
      expect(models).toHaveLength(0);
    });

    it('throws on error', async () => {
      restoreFetch = mockFetch(() => createMockResponse('Internal Server Error', 500));
      await expect(adapter.listModels()).rejects.toThrow('Ollama Tags API error 500: Internal Server Error');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy on 200', async () => {
      let calledUrl: string | undefined;
      restoreFetch = mockFetch((req) => {
        calledUrl = (req as Request).url;
        return createMockResponse('Ollama is running', 200);
      });

      const health = await adapter.healthCheck();
      expect(health.status).toBe('healthy');
      expect(health.provider).toBe('ollama');
      expect(calledUrl).toBe('http://localhost:11434/');
    });

    it('returns down on non-200', async () => {
      restoreFetch = mockFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));
      const health = await adapter.healthCheck();
      expect(health.status).toBe('down');
      expect(health.error).toBe('HTTP 404: Not Found');
    });

    it('returns down with error on network failure', async () => {
      restoreFetch = mockFetch(() => { throw new Error('Network error'); });
      const health = await adapter.healthCheck();
      expect(health.status).toBe('down');
      expect(health.error).toBe('Network error');
    });
  });
});
