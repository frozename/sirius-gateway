import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@sirius/core';
import { LlamactlAdapter } from '../llamactl.adapter.js';
import {
  LlamactlProviderModule,
  type LlamactlNodeConfig,
} from '../llamactl-provider.module.js';

/**
 * Pins how LlamactlProviderModule turns LLAMACTL_NODES into registered
 * adapters: the LLAMACTL_NODE_CONFIGS factory silently drops malformed
 * input, and both LLAMACTL_ADAPTERS factories register one adapter per
 * node as `llamactl-<name>`. The factories are called directly with a
 * stubbed ConfigService and a real ProviderRegistry, so no Nest container
 * boots, and fetch is stubbed so adapter construction is shown to do no I/O.
 */

type ModuleDef = ReturnType<typeof LlamactlProviderModule.forRootAsync>;
type ConfigStub = { get: (name: string, fallback: string) => string };
type ParseFactory = (config: ConfigStub) => LlamactlNodeConfig[];
type AsyncAdaptersFactory = (
  nodes: LlamactlNodeConfig[],
  registry: ProviderRegistry,
) => LlamactlAdapter[];
type AdaptersFactory = (registry: ProviderRegistry) => LlamactlAdapter[];

function providerFor(
  mod: ModuleDef,
  token: string,
): { useFactory: unknown; inject: unknown } {
  for (const p of mod.providers ?? []) {
    if (
      typeof p === 'object' &&
      'provide' in p &&
      p.provide === token &&
      'useFactory' in p
    ) {
      return { useFactory: p.useFactory, inject: p.inject };
    }
  }
  throw new Error(`no factory provider for ${token}`);
}

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let nodeBearer = '';
let seen: string[][] = [];

function parseNodes(raw: string): LlamactlNodeConfig[] {
  const factory = providerFor(
    LlamactlProviderModule.forRootAsync(),
    'LLAMACTL_NODE_CONFIGS',
  ).useFactory as ParseFactory;
  return factory({
    get: (name: string, fallback: string): string => {
      seen.push([name, fallback]);
      return raw;
    },
  });
}

function node(name: string, port: number): LlamactlNodeConfig {
  return { name, baseUrl: `http://127.0.0.1:${String(port)}/v1`, apiKey: nodeBearer };
}

beforeEach(() => {
  nodeBearer = ['plain', 'placeholder'].join('-');
  seen = [];
  fetchCalls = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    fetchCalls.push(String(input));
    throw new Error('unexpected fetch in module-config.test.ts');
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('forRootAsync LLAMACTL_NODE_CONFIGS parsing', () => {
  test('reads LLAMACTL_NODES with an empty-string default', () => {
    parseNodes('');
    expect(seen).toEqual([['LLAMACTL_NODES', '']]);
  });

  test('returns [] for an empty or whitespace-only value', () => {
    expect(parseNodes('')).toEqual([]);
    expect(parseNodes('  \n\t ')).toEqual([]);
  });

  test('returns [] for invalid JSON', () => {
    expect(parseNodes('[{"name":')).toEqual([]);
    expect(parseNodes('not json')).toEqual([]);
  });

  test('returns [] when the JSON is not an array', () => {
    expect(parseNodes(JSON.stringify(node('gpu1', 7843)))).toEqual([]);
    expect(parseNodes('42')).toEqual([]);
    expect(parseNodes('null')).toEqual([]);
  });

  test('keeps only entries whose name, baseUrl and apiKey are strings, in order', () => {
    const first = { ...node('gpu1', 7843), displayName: 'GPU one' };
    const last = node('mac', 7848);
    const raw = JSON.stringify([
      first,
      null,
      'gpu2',
      5,
      { name: 'no-bearer', baseUrl: 'http://127.0.0.1:7844/v1' },
      { name: 'numeric-url', baseUrl: 7845, apiKey: nodeBearer },
      { name: 7846, baseUrl: 'http://127.0.0.1:7846/v1', apiKey: nodeBearer },
      last,
    ]);
    expect(parseNodes(raw)).toEqual([first, last]);
  });
});

describe('LLAMACTL_ADAPTERS registration', () => {
  test('forRootAsync wiring: injects the parsed configs and the registry, exports the adapters', () => {
    const mod = LlamactlProviderModule.forRootAsync();
    expect(providerFor(mod, 'LLAMACTL_ADAPTERS').inject).toEqual([
      'LLAMACTL_NODE_CONFIGS',
      ProviderRegistry,
    ]);
    expect(mod.exports).toEqual(['LLAMACTL_ADAPTERS']);
  });

  test('forRootAsync registers one LlamactlAdapter per node as llamactl-<name>', () => {
    const factory = providerFor(
      LlamactlProviderModule.forRootAsync(),
      'LLAMACTL_ADAPTERS',
    ).useFactory as AsyncAdaptersFactory;
    const registry = new ProviderRegistry();
    const adapters = factory(
      [{ ...node('gpu1', 7843), displayName: 'GPU one' }, node('mac', 7848)],
      registry,
    );
    expect(registry.getNames()).toEqual(['llamactl-gpu1', 'llamactl-mac']);
    expect(adapters).toHaveLength(2);
    expect(adapters[0]).toBeInstanceOf(LlamactlAdapter);
    expect(adapters[1]).toBeInstanceOf(LlamactlAdapter);
    expect(registry.get('llamactl-gpu1')).toBe(adapters[0]);
    expect(registry.get('llamactl-mac')).toBe(adapters[1]);
    expect(fetchCalls).toEqual([]);
  });

  test('forRootAsync registers nothing for an empty node list', () => {
    const factory = providerFor(
      LlamactlProviderModule.forRootAsync(),
      'LLAMACTL_ADAPTERS',
    ).useFactory as AsyncAdaptersFactory;
    const registry = new ProviderRegistry();
    expect(factory([], registry)).toEqual([]);
    expect(registry.getNames()).toEqual([]);
  });

  test('forRoot registers the given nodes as llamactl-<name> and injects only the registry', () => {
    const mod = LlamactlProviderModule.forRoot([node('box', 7850)]);
    const entry = providerFor(mod, 'LLAMACTL_ADAPTERS');
    expect(entry.inject).toEqual([ProviderRegistry]);
    expect(mod.exports).toEqual(['LLAMACTL_ADAPTERS']);
    const registry = new ProviderRegistry();
    const adapters = (entry.useFactory as AdaptersFactory)(registry);
    expect(registry.getNames()).toEqual(['llamactl-box']);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBeInstanceOf(LlamactlAdapter);
    expect(registry.get('llamactl-box')).toBe(adapters[0]);
    expect(fetchCalls).toEqual([]);
  });
});
