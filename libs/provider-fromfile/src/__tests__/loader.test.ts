import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProvidersFile, resolveApiKeyRef, resolveFilePath } from '../loader.js';

/**
 * Pins the sirius-providers.yaml loader: file path precedence, the
 * entry filter, and apiKeyRef resolution. Every env is passed as an
 * explicit object so process.env is never read or mutated.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loader-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveFilePath', () => {
  test('a trimmed LLAMACTL_PROVIDERS_FILE wins over DEV_STORAGE', () => {
    expect(
      resolveFilePath({ LLAMACTL_PROVIDERS_FILE: '  /x/p.yaml  ', DEV_STORAGE: '/d' }),
    ).toBe('/x/p.yaml');
  });

  test('a whitespace-only LLAMACTL_PROVIDERS_FILE falls through to DEV_STORAGE', () => {
    expect(resolveFilePath({ LLAMACTL_PROVIDERS_FILE: '   ', DEV_STORAGE: '/d' })).toBe(
      '/d/sirius-providers.yaml',
    );
  });

  test('DEV_STORAGE is trimmed and joined with sirius-providers.yaml', () => {
    expect(resolveFilePath({ DEV_STORAGE: '  /d  ' })).toBe('/d/sirius-providers.yaml');
  });

  test('a whitespace-only DEV_STORAGE falls back to ~/.llamactl', () => {
    expect(resolveFilePath({ DEV_STORAGE: '   ' })).toBe(
      join(homedir(), '.llamactl', 'sirius-providers.yaml'),
    );
  });

  test('an empty env falls back to ~/.llamactl', () => {
    expect(resolveFilePath({})).toBe(join(homedir(), '.llamactl', 'sirius-providers.yaml'));
  });
});

describe('loadProvidersFile', () => {
  test('a missing file yields no entries', () => {
    expect(loadProvidersFile(join(dir, 'absent.yaml'))).toEqual([]);
  });

  test('an empty file yields no entries', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(path, '');
    expect(loadProvidersFile(path)).toEqual([]);
  });

  test('a non-array providers value yields no entries', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(path, 'providers: foo\n');
    expect(loadProvidersFile(path)).toEqual([]);
  });

  test('a file without a providers key yields no entries', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(path, 'other: 1\n');
    expect(loadProvidersFile(path)).toEqual([]);
  });

  test('keeps only object entries with a string name and kind, in order', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(
      path,
      [
        'providers:',
        '  - name: alpha',
        '    kind: openai',
        '    baseUrl: http://127.0.0.1:9/v1',
        '    apiKeyRef: $PROVIDER_REF_A',
        '    displayName: Alpha',
        '  - null',
        '  - just-a-string',
        '  - name: missing-kind',
        '  - name: 1',
        '    kind: openai',
        '  - name: beta',
        '    kind: openai-compatible',
        '',
      ].join('\n'),
    );
    expect(loadProvidersFile(path)).toEqual([
      {
        name: 'alpha',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKeyRef: '$PROVIDER_REF_A',
        displayName: 'Alpha',
      },
      { name: 'beta', kind: 'openai-compatible' },
    ]);
  });

  test('does not validate kind beyond being a string', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(path, 'providers:\n  - name: gamma\n    kind: made-up\n');
    const entries = loadProvidersFile(path);
    expect(entries.map((e) => e.name)).toEqual(['gamma']);
    expect(String(entries[0]?.kind)).toBe('made-up');
  });

  test('malformed YAML throws instead of yielding no entries', () => {
    const path = join(dir, 'p.yaml');
    writeFileSync(path, 'providers: [unclosed\n');
    expect(() => loadProvidersFile(path)).toThrow();
  });
});

describe('resolveApiKeyRef', () => {
  test('an absent or empty ref resolves to an empty string', () => {
    expect(resolveApiKeyRef(undefined, {})).toBe('');
    expect(resolveApiKeyRef('', {})).toBe('');
  });

  test('a $VAR ref reads the env var and trims it', () => {
    expect(resolveApiKeyRef('$PROVIDER_REF_A', { PROVIDER_REF_A: '  marker-7731  ' })).toBe(
      'marker-7731',
    );
  });

  test('whitespace around a $VAR ref is ignored', () => {
    expect(resolveApiKeyRef('  $PROVIDER_REF_A  ', { PROVIDER_REF_A: 'marker-7731' })).toBe(
      'marker-7731',
    );
  });

  test('a $VAR ref to an unset var resolves to an empty string', () => {
    expect(resolveApiKeyRef('$PROVIDER_REF_MISSING', {})).toBe('');
  });

  test('a file path ref reads the file and trims it', () => {
    const path = join(dir, 'ref.txt');
    writeFileSync(path, 'file-marker-7731\n');
    expect(resolveApiKeyRef(path, {})).toBe('file-marker-7731');
  });

  test('a missing file path ref resolves to an empty string', () => {
    expect(resolveApiKeyRef(join(dir, 'absent.txt'), {})).toBe('');
  });

  test('a ~/ ref expands to env.HOME', () => {
    writeFileSync(join(dir, 'ref.txt'), 'home-marker-7731\n');
    expect(resolveApiKeyRef('~/ref.txt', { HOME: dir })).toBe('home-marker-7731');
  });

  test('a bare ~ ref expands to env.HOME itself', () => {
    const homeFile = join(dir, 'home-file.txt');
    writeFileSync(homeFile, 'tilde-marker-7731\n');
    expect(resolveApiKeyRef('~', { HOME: homeFile })).toBe('tilde-marker-7731');
  });

  test('a ~name/ ref is not expanded', () => {
    mkdirSync(join(dir, 'hother'));
    writeFileSync(join(dir, 'hother', 'ref.txt'), 'expanded-marker-7731\n');
    expect(resolveApiKeyRef('~other/ref.txt', { HOME: join(dir, 'h') })).toBe('');
  });
});
