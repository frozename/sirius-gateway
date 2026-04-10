import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry } from '@sirius/core';
import { AnthropicAdapter } from './anthropic.adapter.js';

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

@Module({})
export class AnthropicProviderModule {
  static forRoot(config: AnthropicProviderConfig): DynamicModule {
    return {
      module: AnthropicProviderModule,
      providers: [
        {
          provide: AnthropicAdapter,
          useFactory: () =>
            new AnthropicAdapter(
              config.apiKey,
              config.baseUrl ?? 'https://api.anthropic.com',
            ),
        },
        {
          provide: 'REGISTER_ANTHROPIC',
          useFactory: (
            registry: ProviderRegistry,
            adapter: AnthropicAdapter,
          ) => {
            registry.register(adapter);
          },
          inject: [ProviderRegistry, AnthropicAdapter],
        },
      ],
      exports: [AnthropicAdapter],
    };
  }

  static forRootAsync(): DynamicModule {
    return {
      module: AnthropicProviderModule,
      providers: [
        {
          provide: AnthropicAdapter,
          useFactory: (config: ConfigService) => {
            const apiKey = config.get<string>('ANTHROPIC_API_KEY', '');
            const baseUrl = config.get<string>(
              'ANTHROPIC_BASE_URL',
              'https://api.anthropic.com',
            );
            return new AnthropicAdapter(apiKey, baseUrl);
          },
          inject: [ConfigService],
        },
        {
          provide: 'REGISTER_ANTHROPIC',
          useFactory: (
            registry: ProviderRegistry,
            adapter: AnthropicAdapter,
          ) => {
            if (adapter.isConfigured()) registry.register(adapter);
          },
          inject: [ProviderRegistry, AnthropicAdapter],
        },
      ],
      exports: [AnthropicAdapter],
    };
  }
}
