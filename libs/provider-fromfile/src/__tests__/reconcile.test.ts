import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ProviderRegistry } from '@sirius/core';
import { reconcileFromFileProviders } from '../fromfile-provider.module.js';

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
