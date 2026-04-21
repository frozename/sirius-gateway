import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ProviderRegistry } from '@sirius/core';
import {
  overlayAnthropicNativeAuth,
  reconcileFromFileProviders,
} from '../fromfile-provider.module.js';

/**
 * Unit tests for the from-file provider reconciliation used by the
 * new /providers/reload endpoint. Writes a yaml → scans → checks
 * the registry diff. Fail-soft behavior (bad entries → skipped
 * with reason) is covered alongside the happy path.
 */

let dir = '';
let yamlPath = '';

function writeProvidersYaml(providers: Array<Record<string, unknown>>): void {
  writeFileSync(yamlPath, stringifyYaml({ providers }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  yamlPath = join(dir, 'sirius-providers.yaml');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('reconcileFromFileProviders', () => {
  test('boot case: empty previouslyOwned + entries → all added', () => {
    writeProvidersYaml([
      {
        name: 'openai',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKeyRef: '$OPENAI_KEY',
      },
      {
        name: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: '$ANT_KEY',
      },
    ]);
    const registry = new ProviderRegistry();
    const { result, ownedAfter } = reconcileFromFileProviders(yamlPath, registry, []);
    expect(result.added.sort()).toEqual(['anthropic', 'openai']);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(ownedAfter.sort()).toEqual(['anthropic', 'openai']);
    expect(registry.getNames().sort()).toEqual(['anthropic', 'openai']);
  });

  test('reload case: yaml unchanged → all kept, nothing added/removed', () => {
    writeProvidersYaml([
      {
        name: 'openai',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
    ]);
    const registry = new ProviderRegistry();
    // First pass registers.
    const { ownedAfter: afterBoot } = reconcileFromFileProviders(yamlPath, registry, []);
    // Second pass sees no change.
    const { result } = reconcileFromFileProviders(yamlPath, registry, afterBoot);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(['openai']);
  });

  test('reload case: yaml shrinks → removed gets the names, registry drops them', () => {
    writeProvidersYaml([
      { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
      { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://b/v1' },
      { name: 'together', kind: 'openai', baseUrl: 'https://c/v1' },
    ]);
    const registry = new ProviderRegistry();
    const { ownedAfter } = reconcileFromFileProviders(yamlPath, registry, []);
    expect(ownedAfter.sort()).toEqual(['anthropic', 'openai', 'together']);

    writeProvidersYaml([
      { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
    ]);
    const { result } = reconcileFromFileProviders(yamlPath, registry, ownedAfter);
    expect(result.removed.sort()).toEqual(['anthropic', 'together']);
    expect(result.kept).toEqual(['openai']);
    expect(registry.getNames()).toEqual(['openai']);
  });

  test('reload case: yaml grows → added gets the new names, existing kept', () => {
    writeProvidersYaml([
      { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
    ]);
    const registry = new ProviderRegistry();
    const { ownedAfter } = reconcileFromFileProviders(yamlPath, registry, []);

    writeProvidersYaml([
      { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
      { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://b/v1' },
    ]);
    const { result } = reconcileFromFileProviders(yamlPath, registry, ownedAfter);
    expect(result.added).toEqual(['anthropic']);
    expect(result.kept).toEqual(['openai']);
    expect(registry.getNames().sort()).toEqual(['anthropic', 'openai']);
  });

  test('missing yaml + previously-owned → everything gets removed', () => {
    const registry = new ProviderRegistry();
    // Pretend boot registered two entries.
    writeProvidersYaml([
      { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
      { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://b/v1' },
    ]);
    const { ownedAfter } = reconcileFromFileProviders(yamlPath, registry, []);
    // Now delete the yaml entirely.
    rmSync(yamlPath);
    const { result } = reconcileFromFileProviders(yamlPath, registry, ownedAfter);
    expect(result.removed.sort()).toEqual(['anthropic', 'openai']);
    expect(registry.getNames()).toEqual([]);
  });

  test('anthropic entry: listModels uses x-api-key + anthropic-version, NOT Authorization', async () => {
    // Captures the Nova-vs-Anthropic auth regression: the anthropic
    // /v1/models endpoint rejects Bearer tokens with 401. When an
    // operator declares `kind: anthropic` in sirius-providers.yaml
    // the resulting adapter's listModels must hit Anthropic-native
    // headers, not Nova's default Bearer.
    process.env.ANT_KEY = 'sk-test-native';
    writeProvidersYaml([
      {
        name: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: '$ANT_KEY',
      },
    ]);
    const registry = new ProviderRegistry();
    reconcileFromFileProviders(yamlPath, registry, []);
    const adapter = registry.get('anthropic');
    expect(adapter).toBeDefined();

    // Swap the real listModels helper for one that records headers.
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const recordingAdapter = overlayAnthropicNativeAuth(
      adapter!,
      {
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKeyRef: '$ANT_KEY',
      },
      (async (input: Request | string | URL, init?: RequestInit) => {
        const req =
          input instanceof Request ? input : new Request(String(input), init);
        capturedUrl = req.url;
        capturedHeaders = Object.fromEntries(req.headers.entries());
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-haiku-4-5',
                display_name: 'Claude Haiku 4.5',
                type: 'model',
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const models = await recordingAdapter.listModels();
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/models');
    expect(capturedHeaders['x-api-key']).toBe('sk-test-native');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    // Critical: NO Authorization header — that's the exact regression.
    expect(capturedHeaders['authorization']).toBeUndefined();
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('claude-haiku-4-5');
    expect(models[0]!.provider).toBe('anthropic');
    delete process.env.ANT_KEY;
  });

  test('anthropic entry: dated model ids emit an undated alias entry', async () => {
    // Anthropic's /v1/models returns `claude-haiku-4-5-20251001`;
    // operators write `claude-haiku-4-5`. Both forms must route to
    // anthropic.
    const dummy = {
      name: 'anthropic',
      async createResponse() { throw new Error('unused'); },
      async *streamResponse() { yield { type: 'done', finishReason: 'stop' } as const; },
      async createEmbeddings() { throw new Error('unused'); },
      async listModels() { return []; },
      async healthCheck() { return { provider: 'anthropic', status: 'healthy' as const, lastChecked: new Date() }; },
    };
    const overlayed = overlayAnthropicNativeAuth(
      dummy,
      { name: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
      (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-haiku-4-5-20251001',
                display_name: 'Claude Haiku 4.5',
                type: 'model',
                created_at: '2025-10-01T00:00:00Z',
              },
              {
                // An id without a trailing date — no alias should be emitted.
                id: 'claude-opus-4-7',
                display_name: 'Claude Opus 4.7',
                type: 'model',
                created_at: '2026-01-01T00:00:00Z',
              },
            ],
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch,
    );
    const models = await overlayed.listModels();
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual([
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-7',
    ]);
  });

  test('anthropic entry: 401 error surfaces upstream message', async () => {
    process.env.ANT_KEY = 'sk-bad';
    const dummy = {
      name: 'anthropic',
      async createResponse() { throw new Error('unused'); },
      async *streamResponse() { yield { type: 'done', finishReason: 'stop' } as const; },
      async createEmbeddings() { throw new Error('unused'); },
      async listModels() { return []; },
      async healthCheck() { return { provider: 'anthropic', status: 'healthy' as const, lastChecked: new Date() }; },
    };
    const overlayed = overlayAnthropicNativeAuth(
      dummy,
      { name: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyRef: '$ANT_KEY' },
      (async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'Invalid bearer token' },
          }),
          { status: 401 },
        )) as unknown as typeof globalThis.fetch,
    );
    await expect(overlayed.listModels()).rejects.toThrow(
      /anthropic \/models 401.*Invalid bearer token/,
    );
    delete process.env.ANT_KEY;
  });

  test('malformed entry → skipped with reason, others still register', () => {
    writeProvidersYaml([
      {
        name: 'ok-entry',
        kind: 'openai',
        baseUrl: 'https://a/v1',
      },
      {
        // No baseUrl + kind has no default → novaProviderFor throws.
        name: 'bad-entry',
        kind: 'custom-no-default',
      },
    ]);
    const registry = new ProviderRegistry();
    const { result } = reconcileFromFileProviders(yamlPath, registry, []);
    expect(result.added).toEqual(['ok-entry']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('bad-entry');
    expect(result.skipped[0]!.reason).toContain('no baseUrl');
  });
});
