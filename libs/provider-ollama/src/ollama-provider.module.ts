import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry } from '@sirius/core';
import { OllamaAdapter } from './ollama.adapter.js';

export interface OllamaProviderConfig {
  baseUrl?: string;
}

@Module({})
export class OllamaProviderModule {
  static forRoot(config?: OllamaProviderConfig): DynamicModule {
    return {
      module: OllamaProviderModule,
      providers: [
        {
          provide: OllamaAdapter,
          useFactory: () =>
            new OllamaAdapter(config?.baseUrl ?? 'http://localhost:11434'),
        },
        {
          provide: 'REGISTER_OLLAMA',
          useFactory: (registry: ProviderRegistry, adapter: OllamaAdapter) => {
            registry.register(adapter);
          },
          inject: [ProviderRegistry, OllamaAdapter],
        },
      ],
      exports: [OllamaAdapter],
    };
  }

  static forRootAsync(): DynamicModule {
    return {
      module: OllamaProviderModule,
      providers: [
        {
          provide: OllamaAdapter,
          useFactory: (config: ConfigService) => {
            const baseUrl = config.get<string>(
              'OLLAMA_BASE_URL',
              'http://localhost:11434',
            );
            return new OllamaAdapter(baseUrl);
          },
          inject: [ConfigService],
        },
        {
          provide: 'REGISTER_OLLAMA',
          useFactory: (registry: ProviderRegistry, adapter: OllamaAdapter) => {
            if (adapter.isConfigured()) registry.register(adapter);
          },
          inject: [ProviderRegistry, OllamaAdapter],
        },
      ],
      exports: [OllamaAdapter],
    };
  }
}
