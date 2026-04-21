import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ProviderRegistry } from '@sirius/core';
import { ModelRegistryService } from '@sirius/model-registry';

/**
 * Integration smoke test for the llamactl↔sirius convergence:
 *
 *   1. Write a hermetic `sirius-providers.yaml` (the file llamactl's
 *      `sirius add-provider` command manages).
 *   2. Write a hermetic `LLAMACTL_NODES` JSON (what llamactl's
 *      `sirius export` command emits).
 *   3. Boot sirius with both pointed at the hermetic paths.
 *   4. Assert the ProviderRegistry carries the expected adapters:
 *      * one per `sirius-providers.yaml` entry (via
 *        `@sirius/provider-fromfile`)
 *      * one per `LLAMACTL_NODES` entry (via
 *        `@sirius/provider-llamactl`)
 *      * plus the built-in openai/anthropic/ollama adapters that
 *        register themselves unconditionally.
 *   5. Assert that the discover-and-register boot step upserted
 *      models exposed via `listModels()` into the registry so
 *      routing can resolve them.
 *
 * Spins a tiny Bun.serve stub for the openai-compatible upstream so
 * the from-file provider's `listModels()` returns real data.
 */

const UPSTREAM_PORT = 39215;
let tmp = '';
let app: INestApplication | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
const originalEnv = { ...process.env };

beforeAll(async () => {
  // Hermetic openai-compat upstream that mimics a llama-server
  // serving a single aliased model.
  upstream = Bun.serve({
    port: UPSTREAM_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json({
          data: [
            { id: 'qwen2.5-0.5b-instruct', created: 100, owned_by: 'llamacpp' },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  tmp = mkdtempSync(join(tmpdir(), 'sirius-llamactl-smoke-'));

  const providersPath = join(tmp, 'sirius-providers.yaml');
  writeFileSync(
    providersPath,
    [
      'apiVersion: llamactl/v1',
      'kind: SiriusProviderList',
      'providers:',
      '  - name: openai-fromfile',
      '    kind: openai',
      '    baseUrl: http://127.0.0.1:1/v1',
      '    apiKeyRef: $FAKE_OPENAI_KEY',
      '  - name: anthropic-fromfile',
      '    kind: anthropic',
      '    baseUrl: http://127.0.0.1:1/v1',
      '    apiKeyRef: $FAKE_ANTHROPIC_KEY',
      '  - name: local-llm',
      '    kind: openai-compatible',
      `    baseUrl: http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      '',
    ].join('\n'),
  );

  const llamactlNodes = JSON.stringify([
    { name: 'gpu1', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'bearer-1' },
    { name: 'mac-mini', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'bearer-2' },
  ]);

  process.env.FAKE_OPENAI_KEY = 'sk-fake-openai';
  process.env.FAKE_ANTHROPIC_KEY = 'sk-fake-anthropic';
  process.env.LLAMACTL_PROVIDERS_FILE = providersPath;
  process.env.LLAMACTL_NODES = llamactlNodes;
  process.env.SIRIUS_API_KEYS = 'sk-test';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  app = null;
  upstream?.stop(true);
  upstream = null;
  rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

describe('sirius + llamactl integration', () => {
  test('ProviderRegistry carries fromfile + llamactl adapters after boot', () => {
    expect(app).toBeTruthy();
    const registry = app!.get(ProviderRegistry);
    const all = registry.getAll();
    const names = new Set(all.map((p) => p.name));

    // fromfile adapters (from sirius-providers.yaml)
    expect(names.has('openai-fromfile')).toBe(true);
    expect(names.has('anthropic-fromfile')).toBe(true);
    expect(names.has('local-llm')).toBe(true);

    // llamactl node adapters (from LLAMACTL_NODES)
    expect(names.has('llamactl-gpu1')).toBe(true);
    expect(names.has('llamactl-mac-mini')).toBe(true);
  });

  test('ModelRegistry resolves models discovered via listModels()', () => {
    // Regression test for the /v1/chat/completions routing bug:
    // models discovered through a provider's `listModels()` must
    // populate the routing map so `resolveModel()` doesn't
    // short-circuit with "does not exist".
    const modelRegistry = app!.get(ModelRegistryService);
    const resolved = modelRegistry.resolveModel('qwen2.5-0.5b-instruct');
    expect(resolved).toEqual({
      modelId: 'qwen2.5-0.5b-instruct',
      provider: 'local-llm',
    });
  });

  test('GET /v1/models reflects the registered adapters', async () => {
    const res = await (app!.getHttpAdapter().getInstance() as unknown as {
      inject: (opts: {
        method: string;
        url: string;
        headers: Record<string, string>;
      }) => Promise<{ statusCode: number; json: () => { data?: Array<{ id: string }> } }>;
    }).inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Upstream `/v1/models` calls fail (nothing on 127.0.0.1:1) but
    // the gateway surface itself is alive — the auth gate passed
    // and the controller responded with a structured body.
    expect(body).toBeTruthy();
    const ids = new Set((body.data ?? []).map((m) => m.id));
    expect(ids.has('qwen2.5-0.5b-instruct')).toBe(true);
  });
});
