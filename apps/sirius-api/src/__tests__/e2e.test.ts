import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createE2eApp } from './e2e-setup';
import type { INestApplication } from '@nestjs/common';

describe('Sirius Gateway E2E', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.SIRIUS_API_KEYS = 'sk-test';
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health', () => {
    it('GET /health returns 200', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });
  });

  describe('Auth', () => {
    it('returns 401 for missing API key', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_api_key');
    });

    it('returns 200 for valid API key', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer sk-test' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('Models API', () => {
    it('GET /v1/models returns model list', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer sk-test' },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.object).toBe('list');
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('GET /v1/models/:id returns single model', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/v1/models/gpt-4o',
        headers: { authorization: 'Bearer sk-test' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('gpt-4o');
    });
  });

  describe('Chat Completions API', () => {
    it('POST /v1/chat/completions returns chat completion', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 
          authorization: 'Bearer sk-test',
          'content-type': 'application/json'
        },
        payload: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.object).toBe('chat.completion');
      expect(data.choices[0].message.content).toBeDefined();
    });

    it('POST /v1/chat/completions with stream: true returns SSE', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 
          authorization: 'Bearer sk-test',
          'content-type': 'application/json'
        },
        payload: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.body).toContain('data: {"id":"chatcmpl-');
      expect(res.body).toContain('data: [DONE]');
    });

    it('returns 400 for missing model', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 
          authorization: 'Bearer sk-test',
          'content-type': 'application/json'
        },
        payload: {
          messages: [{ role: 'user', content: 'Hello' }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('model_required');
    });
  });

  describe('Embeddings API', () => {
    it('POST /v1/embeddings returns embedding response', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'POST',
        url: '/v1/embeddings',
        headers: { 
          authorization: 'Bearer sk-test',
          'content-type': 'application/json'
        },
        payload: {
          model: 'text-embedding-3-small',
          input: 'test',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.object).toBe('list');
      expect(data.data[0].embedding).toBeDefined();
    });
  });

  describe('Providers API', () => {
    it('GET /providers/health returns provider status', async () => {
      const res = await (app.getHttpAdapter().getInstance() as any).inject({
        method: 'GET',
        url: '/providers/health',
        headers: { authorization: 'Bearer sk-test' },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.status).toBeDefined();
      expect(Array.isArray(data.providers)).toBe(true);
    });
  });
});
