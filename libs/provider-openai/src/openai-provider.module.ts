import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderRegistry } from '@sirius/core';
import { OpenAiAdapter } from './openai.adapter.js';

export interface OpenAiProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

@Module({})
export class OpenAiProviderModule {
  static forRoot(config: OpenAiProviderConfig): DynamicModule {
    return {
      module: OpenAiProviderModule,
      providers: [
        {
          provide: OpenAiAdapter,
          useFactory: () =>
            new OpenAiAdapter(
              config.apiKey,
              config.baseUrl ?? 'https://api.openai.com',
            ),
        },
        {
          provide: 'REGISTER_OPENAI',
          useFactory: (registry: ProviderRegistry, adapter: OpenAiAdapter) => {
            registry.register(adapter);
          },
          inject: [ProviderRegistry, OpenAiAdapter],
        },
      ],
      exports: [OpenAiAdapter],
    };
  }

  static forRootAsync(): DynamicModule {
    return {
      module: OpenAiProviderModule,
      providers: [
        {
          provide: OpenAiAdapter,
          useFactory: (config: ConfigService) => {
            const apiKey = config.get<string>('OPENAI_API_KEY', '');
            const baseUrl = config.get<string>(
              'OPENAI_BASE_URL',
              'https://api.openai.com',
            );
            return new OpenAiAdapter(apiKey, baseUrl);
          },
          inject: [ConfigService],
        },
        {
          provide: 'REGISTER_OPENAI',
          useFactory: (registry: ProviderRegistry, adapter: OpenAiAdapter) => {
            if (adapter.isConfigured()) registry.register(adapter);
          },
          inject: [ProviderRegistry, OpenAiAdapter],
        },
      ],
      exports: [OpenAiAdapter],
    };
  }
}
