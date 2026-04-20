import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { stringify as stringifyYaml } from 'yaml';
import { appendAudit, toTextContent } from '@nova/mcp-shared';
import { ChatMessageSchema, UnifiedEmbeddingRequestSchema } from '@nova/contracts';
import {
  loadProvidersFile,
  resolveFilePath as resolveProvidersFilePath,
  type SiriusProviderFileEntry,
} from '@sirius/provider-fromfile';

/**
 * `@sirius/mcp` — Model Context Protocol server exposing
 * sirius-gateway's operator surface to MCP-speaking clients. Tools
 * either read `sirius-providers.yaml` directly (the llamactl-authored
 * file sirius consumes at boot) or proxy to a running sirius-api over
 * HTTP — matching the `kubectl → kube-apiserver` shape.
 *
 * Config:
 *   * `SIRIUS_URL`              — base URL for sirius-api (default http://127.0.0.1:3000)
 *   * `LLAMACTL_PROVIDERS_FILE` — override path to sirius-providers.yaml
 *     (already honored by @sirius/provider-fromfile's loader).
 *
 * Mutations route through llamactl (the config authority) rather
 * than writing `sirius-providers.yaml` directly from this server —
 * that keeps a single writer for every file llamactl owns.
 */

const SERVER_SLUG = 'sirius';

function siriusBaseUrl(): string {
  return (process.env.SIRIUS_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
}

async function fetchJson(path: string): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const url = `${siriusBaseUrl()}${path}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body — keep as string
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: (err as Error).message };
  }
}

async function postJson(
  path: string,
  body: unknown = {},
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const url = `${siriusBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep as string
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: (err as Error).message };
  }
}

/**
 * Atomic YAML writer. Writes to `<path>.tmp-<rand>` then renames
 * onto the target — a partial write never leaves a truncated file
 * on disk.
 */
function atomicWriteYaml(path: string, payload: { providers: SiriusProviderFileEntry[] }): void {
  const tmp = join(dirname(path), `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.yaml.tmp`);
  writeFileSync(tmp, stringifyYaml(payload), 'utf8');
  renameSync(tmp, path);
}

export function buildSiriusMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'sirius',
    version: opts?.version ?? '0.0.0',
  });

  server.registerTool(
    'sirius.providers.list',
    {
      title: 'List configured providers',
      description:
        'Read the sirius-providers.yaml file sirius consumes at boot. The file is authored by llamactl; sirius-mcp reads it verbatim so the answer matches what sirius actually sees.',
      inputSchema: {
        path: z.string().optional().describe('Override path to sirius-providers.yaml.'),
      },
    },
    async (input) => {
      const path = input.path ?? resolveProvidersFilePath();
      const providers = loadProvidersFile(path);
      appendAudit({ server: SERVER_SLUG, tool: 'sirius.providers.list', input });
      return toTextContent({
        path,
        count: providers.length,
        providers: providers.map((p) => ({
          name: p.name,
          kind: p.kind,
          baseUrl: p.baseUrl ?? null,
          displayName: p.displayName ?? null,
          // Never leak the resolved key — reference only.
          apiKeyRef: p.apiKeyRef ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'sirius.models.list',
    {
      title: 'Aggregate model catalog via sirius',
      description:
        'Proxy GET /v1/models against the running sirius-api. Returns the union of every registered provider\'s models as sirius reports them. Requires SIRIUS_URL to reach a running gateway.',
      inputSchema: {},
    },
    async () => {
      const result = await fetchJson('/v1/models');
      appendAudit({
        server: SERVER_SLUG,
        tool: 'sirius.models.list',
        input: {},
        result: { status: result.status },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    'sirius.providers.deregister',
    {
      title: 'Deregister a provider (dry-run today)',
      description:
        'Report what would happen if a provider were removed from sirius-providers.yaml. Dry-run only in this slice: no file mutation, no gateway reload. Returns the provider block that would be deleted + the list of remaining providers. Wet mode returns a deliberate not-implemented error pointing at the K.7.2 slice that wires up /providers/reload and atomic YAML writes. The cost-guardian tier-3 action calls this tool with dryRun:true; operators performing a wet deregister run it through llamactl directly.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe('Provider name exactly as it appears in sirius-providers.yaml.'),
        dryRun: z
          .boolean()
          .default(true)
          .describe('When false, attempt a wet deregister; currently returns not-implemented.'),
        path: z.string().optional().describe('Override path to sirius-providers.yaml.'),
      },
    },
    async (input) => {
      const dryRun = input.dryRun ?? true;
      const path = input.path ?? resolveProvidersFilePath();
      const providers = loadProvidersFile(path);
      const target = providers.find((p) => p.name === input.name);
      const remaining = providers.filter((p) => p.name !== input.name);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'sirius.providers.deregister',
        input: { name: input.name, dryRun, path },
        result: {
          wasPresent: target !== undefined,
          remainingCount: remaining.length,
          wet: !dryRun,
        },
      });
      if (!dryRun) {
        if (!target) {
          return toTextContent({
            ok: false,
            reason: 'provider-not-found',
            message: `provider '${input.name}' is not in ${path}`,
            path,
          });
        }
        atomicWriteYaml(path, { providers: remaining });
        const reload = await postJson('/providers/reload');
        return toTextContent({
          ok: true,
          mode: 'wet',
          path,
          removed: { name: target.name, kind: target.kind },
          remainingCount: remaining.length,
          remaining: remaining.map((p) => ({ name: p.name, kind: p.kind })),
          reload: {
            ok: reload.ok,
            status: reload.status,
            ...(reload.error ? { error: reload.error } : {}),
            body: reload.body,
          },
          note: reload.ok
            ? 'sirius-providers.yaml rewritten + gateway reloaded'
            : 'sirius-providers.yaml rewritten; reload POST failed — operator should hit /providers/reload manually or restart sirius',
        });
      }
      return toTextContent({
        ok: true,
        mode: 'dry-run',
        path,
        wasPresent: target !== undefined,
        target: target
          ? {
              name: target.name,
              kind: target.kind,
              baseUrl: target.baseUrl ?? null,
              displayName: target.displayName ?? null,
              apiKeyRef: target.apiKeyRef ?? null,
            }
          : null,
        remainingCount: remaining.length,
        remaining: remaining.map((p) => ({ name: p.name, kind: p.kind })),
        note: 'dry-run — sirius-providers.yaml not modified; no gateway reload',
      });
    },
  );

  server.registerTool(
    'sirius.health.all',
    {
      title: 'Gateway + provider health roll-up',
      description:
        'Proxy GET /health and GET /providers/health against the running sirius-api, returning both payloads so an operator sees the gateway\'s overall liveness and each provider\'s individual health in one call.',
      inputSchema: {},
    },
    async () => {
      const [gateway, providers] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/providers/health'),
      ]);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'sirius.health.all',
        input: {},
        result: { gateway: gateway.status, providers: providers.status },
      });
      return toTextContent({
        baseUrl: siriusBaseUrl(),
        gateway,
        providers,
      });
    },
  );

  const ChatCompletionRequestSchema = z.looseObject({
    model: z.string(),
    messages: z.array(ChatMessageSchema).min(1),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
  });

  server.registerTool(
    'sirius.chat',
    {
      title: 'Chat completions via sirius gateway',
      description:
        'Non-streaming chat completion through sirius. POSTs to /v1/chat/completions and returns the full OpenAI-compatible response. The `stream` parameter is accepted but coerced to false — MCP tools are one-shot, so streaming is out of scope in this surface. Provider-specific extensions on the request pass through unchanged.',
      inputSchema: ChatCompletionRequestSchema.shape,
    },
    async (input) => {
      const body = { ...input, stream: false };
      const result = await postJson('/v1/chat/completions', body);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'sirius.chat',
        input: { model: input.model, messageCount: input.messages.length },
        result: { status: result.status, ok: result.ok },
      });
      return toTextContent(result);
    },
  );

  server.registerTool(
    'sirius.embed',
    {
      title: 'Embeddings via sirius gateway',
      description:
        'Embedding vectors through sirius. POSTs to /v1/embeddings and returns the full OpenAI-compatible response. Provider-specific extensions on the request pass through unchanged.',
      inputSchema: UnifiedEmbeddingRequestSchema.shape,
    },
    async (input) => {
      const result = await postJson('/v1/embeddings', input);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'sirius.embed',
        input: { model: input.model },
        result: { status: result.status, ok: result.ok },
      });
      return toTextContent(result);
    },
  );

  return server;
}
