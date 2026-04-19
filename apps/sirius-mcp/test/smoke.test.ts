import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { buildSiriusMcpServer } from '../src/server.js';

/**
 * Smoke test for the sirius-mcp surface. `sirius.providers.list` is
 * exercised against a tempdir-scoped sirius-providers.yaml so the
 * suite stays hermetic. The HTTP-proxied tools (`models.list` /
 * `health.all`) are verified for their envelope shape + audit
 * emission — a live sirius-api isn't required.
 */

let runtimeDir = '';
let auditDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'sirius-mcp-runtime-'));
  auditDir = mkdtempSync(join(tmpdir(), 'sirius-mcp-audit-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    LLAMACTL_PROVIDERS_FILE: join(runtimeDir, 'sirius-providers.yaml'),
    LLAMACTL_MCP_AUDIT_DIR: auditDir,
    SIRIUS_URL: 'http://127.0.0.1:1', // unreachable on purpose
  });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

async function connected() {
  const server = buildSiriusMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.startsWith('sirius-'));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const body = readFileSync(join(auditDir, f), 'utf8');
    for (const line of body.trim().split('\n')) {
      if (line) out.push(JSON.parse(line));
    }
  }
  return out;
}

describe('@sirius/mcp surface', () => {
  test('listTools advertises the sirius operator tools', async () => {
    const client = await connected();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'sirius.health.all',
      'sirius.models.list',
      'sirius.providers.deregister',
      'sirius.providers.list',
    ]);
  });

  test('sirius.providers.list reads the YAML file and strips keys', async () => {
    const yamlPath = join(runtimeDir, 'sirius-providers.yaml');
    writeFileSync(
      yamlPath,
      stringifyYaml({
        providers: [
          {
            name: 'openai',
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyRef: '$OPENAI_API_KEY',
          },
          {
            name: 'anthropic',
            kind: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            apiKeyRef: '$ANTHROPIC_API_KEY',
          },
        ],
      }),
    );

    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.providers.list',
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      count: number;
      providers: Array<{ name: string; kind: string; apiKeyRef: string | null }>;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.providers.map((p) => p.name).sort()).toEqual(['anthropic', 'openai']);
    // apiKeyRef is a reference, never a resolved secret.
    for (const p of parsed.providers) {
      expect(p.apiKeyRef?.startsWith('$')).toBe(true);
    }

    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('sirius.providers.list');
  });

  test('sirius.providers.deregister dry-run reports target + remaining + leaves YAML untouched', async () => {
    const yamlPath = join(runtimeDir, 'sirius-providers.yaml');
    const original = stringifyYaml({
      providers: [
        { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1', apiKeyRef: '$OPENAI_KEY' },
        { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://b/v1', apiKeyRef: '$ANT_KEY' },
        { name: 'together', kind: 'openai', baseUrl: 'https://c/v1', apiKeyRef: '$TGTHR_KEY' },
      ],
    });
    writeFileSync(yamlPath, original);

    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.providers.deregister',
      arguments: { name: 'anthropic' }, // dryRun default true
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      mode: string;
      wasPresent: boolean;
      target: { name: string; apiKeyRef: string | null } | null;
      remainingCount: number;
      remaining: Array<{ name: string; kind: string }>;
      note: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.wasPresent).toBe(true);
    expect(parsed.target!.name).toBe('anthropic');
    // apiKeyRef is a reference, never a resolved secret.
    expect(parsed.target!.apiKeyRef?.startsWith('$')).toBe(true);
    expect(parsed.remainingCount).toBe(2);
    expect(parsed.remaining.map((p) => p.name).sort()).toEqual(['openai', 'together']);

    // YAML on disk unchanged.
    expect(readFileSync(yamlPath, 'utf8')).toBe(original);

    const audits = auditLines();
    expect(audits[0]!.tool).toBe('sirius.providers.deregister');
    expect((audits[0]!.result as { wet: boolean }).wet).toBe(false);
  });

  test('sirius.providers.deregister dry-run flags unknown provider as wasPresent:false', async () => {
    const yamlPath = join(runtimeDir, 'sirius-providers.yaml');
    writeFileSync(
      yamlPath,
      stringifyYaml({ providers: [{ name: 'openai', kind: 'openai' }] }),
    );
    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.providers.deregister',
      arguments: { name: 'does-not-exist' },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      wasPresent: boolean;
      target: null;
      remainingCount: number;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.wasPresent).toBe(false);
    expect(parsed.target).toBeNull();
    expect(parsed.remainingCount).toBe(1);
  });

  test('sirius.providers.deregister wet mode rewrites yaml + posts /providers/reload', async () => {
    const yamlPath = join(runtimeDir, 'sirius-providers.yaml');
    writeFileSync(
      yamlPath,
      stringifyYaml({
        providers: [
          { name: 'openai', kind: 'openai', baseUrl: 'https://a/v1' },
          { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://b/v1' },
        ],
      }),
    );
    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.providers.deregister',
      arguments: { name: 'openai', dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      mode: string;
      removed: { name: string };
      remaining: Array<{ name: string }>;
      remainingCount: number;
      reload: { ok: boolean; status: number };
      note: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('wet');
    expect(parsed.removed.name).toBe('openai');
    expect(parsed.remainingCount).toBe(1);
    expect(parsed.remaining[0]!.name).toBe('anthropic');
    // SIRIUS_URL points at 127.0.0.1:1 (unreachable) → reload POST
    // fails, but the YAML write already succeeded.
    expect(parsed.reload.ok).toBe(false);
    expect(parsed.note).toContain('reload POST failed');

    // YAML on disk is the post-removal shape.
    const body = readFileSync(yamlPath, 'utf8');
    expect(body).toContain('anthropic');
    expect(body).not.toContain('name: openai');
  });

  test('sirius.providers.deregister wet mode on absent provider → provider-not-found', async () => {
    writeFileSync(
      join(runtimeDir, 'sirius-providers.yaml'),
      stringifyYaml({ providers: [{ name: 'openai', kind: 'openai' }] }),
    );
    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.providers.deregister',
      arguments: { name: 'does-not-exist', dryRun: false },
    });
    const parsed = JSON.parse(textOf(result)) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('provider-not-found');
  });

  test('sirius.health.all gracefully surfaces the no-gateway case', async () => {
    const client = await connected();
    const result = await client.callTool({
      name: 'sirius.health.all',
      arguments: {},
    });
    const parsed = JSON.parse(textOf(result)) as {
      baseUrl: string;
      gateway: { ok: boolean; status: number };
      providers: { ok: boolean; status: number };
    };
    // With SIRIUS_URL pointed at an unreachable host, both probes
    // should report ok: false with a non-200 / zero status and not
    // throw from the handler.
    expect(parsed.baseUrl).toBe('http://127.0.0.1:1');
    expect(parsed.gateway.ok).toBe(false);
    expect(parsed.providers.ok).toBe(false);

    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('sirius.health.all');
  });
});
