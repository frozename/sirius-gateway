import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry } from '@sirius/core';
import { LlamactlAdapter } from './llamactl.adapter.js';

/**
 * Sirius registration module for llamactl nodes. Reads a JSON blob
 * from `LLAMACTL_NODES` (or an injected config) describing each
 * llamactl agent node:
 *
 *     LLAMACTL_NODES='[
 *       {"name":"gpu1","baseUrl":"https://gpu1.lan:7843/v1","apiKey":"<bearer>"},
 *       {"name":"mac-mini","baseUrl":"https://mac-mini.lan:7843/v1","apiKey":"<bearer>"}
 *     ]'
 *
 * One `LlamactlAdapter` is registered per node with the
 * `ProviderRegistry` under the name `llamactl-<nodeName>`. The
 * llamactl CLI ships a `llamactl sirius export` command that emits
 * this JSON from the user's kubeconfig so they don't write it by hand.
 *
 * TLS note: sirius runs on Node.js. For self-signed llamactl agents,
 * set `NODE_EXTRA_CA_CERTS` to the PEM emitted by `llamactl agent
 * init` before starting sirius — the current adapter uses Node's
 * global fetch without a custom dispatcher. Pinned-CA support will
 * follow when the node-side provider-llamactl gains an undici
 * dispatcher hook.
 */

export interface LlamactlNodeConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  displayName?: string;
}

@Module({})
export class LlamactlProviderModule {
  static forRoot(nodes: LlamactlNodeConfig[]): DynamicModule {
    return buildModule(nodes);
  }

  static forRootAsync(): DynamicModule {
    return {
      module: LlamactlProviderModule,
      providers: [
        {
          provide: 'LLAMACTL_NODE_CONFIGS',
          useFactory: (config: ConfigService): LlamactlNodeConfig[] => {
            const raw = config.get<string>('LLAMACTL_NODES', '');
            if (!raw.trim()) return [];
            try {
              const parsed = JSON.parse(raw) as unknown;
              if (!Array.isArray(parsed)) return [];
              return parsed.filter(
                (n): n is LlamactlNodeConfig =>
                  typeof n === 'object' &&
                  n !== null &&
                  typeof (n as LlamactlNodeConfig).name === 'string' &&
                  typeof (n as LlamactlNodeConfig).baseUrl === 'string' &&
                  typeof (n as LlamactlNodeConfig).apiKey === 'string',
              );
            } catch {
              return [];
            }
          },
          inject: [ConfigService],
        },
        {
          provide: 'LLAMACTL_ADAPTERS',
          useFactory: (
            nodes: LlamactlNodeConfig[],
            registry: ProviderRegistry,
          ): LlamactlAdapter[] => {
            const adapters = nodes.map(
              (n) =>
                new LlamactlAdapter({
                  nodeName: n.name,
                  baseUrl: n.baseUrl,
                  apiKey: n.apiKey,
                  ...(n.displayName ? { displayName: n.displayName } : {}),
                }),
            );
            for (const a of adapters) registry.register(a);
            return adapters;
          },
          inject: ['LLAMACTL_NODE_CONFIGS', ProviderRegistry],
        },
      ],
      exports: ['LLAMACTL_ADAPTERS'],
    };
  }
}

function buildModule(nodes: LlamactlNodeConfig[]): DynamicModule {
  return {
    module: LlamactlProviderModule,
    providers: [
      {
        provide: 'LLAMACTL_ADAPTERS',
        useFactory: (registry: ProviderRegistry): LlamactlAdapter[] => {
          const adapters = nodes.map(
            (n) =>
              new LlamactlAdapter({
                nodeName: n.name,
                baseUrl: n.baseUrl,
                apiKey: n.apiKey,
                ...(n.displayName ? { displayName: n.displayName } : {}),
              }),
          );
          for (const a of adapters) registry.register(a);
          return adapters;
        },
        inject: [ProviderRegistry],
      },
    ],
    exports: ['LLAMACTL_ADAPTERS'],
  };
}
