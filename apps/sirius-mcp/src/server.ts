import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appendAudit, toTextContent } from '@nova/mcp-shared';
import {
  loadProvidersFile,
  resolveFilePath as resolveProvidersFilePath,
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

  return server;
}
