import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { SiriusCoreModule } from '@sirius/core';
import { AuthModule } from '@sirius/auth';
import { ObservabilityModule, createLoggerConfig } from '@sirius/observability';
import { OpenAiCompatModule } from '@sirius/compat-openai';
import { ModelRegistryModule } from '@sirius/model-registry';
import { RoutingModule } from '@sirius/routing';
import { PolicyModule } from '@sirius/policy';
import { OpenAiProviderModule } from '@sirius/provider-openai';
import { AnthropicProviderModule } from '@sirius/provider-anthropic';
import { OllamaProviderModule } from '@sirius/provider-ollama';
import { LlamactlProviderModule } from '@sirius/provider-llamactl';
import { FromFileProviderModule } from '@sirius/provider-fromfile';
import { GatewayService } from './gateway.service';
import { ChatCompletionsController } from './controllers/chat-completions.controller';
import { ResponsesController } from './controllers/responses.controller';
import { EmbeddingsController } from './controllers/embeddings.controller';
import { ModelsController } from './controllers/models.controller';
import { HealthController } from './controllers/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    LoggerModule.forRoot(createLoggerConfig()),

    // Core
    SiriusCoreModule,

    // Cross-cutting
    AuthModule,
    ObservabilityModule,
    PolicyModule,

    // Domain
    OpenAiCompatModule,
    ModelRegistryModule,
    RoutingModule,

    // Providers (async config from env)
    OpenAiProviderModule.forRootAsync(),
    AnthropicProviderModule.forRootAsync(),
    OllamaProviderModule.forRootAsync(),
    LlamactlProviderModule.forRootAsync(),
    FromFileProviderModule.forRootAsync(),
  ],
  controllers: [
    HealthController,
    ChatCompletionsController,
    ResponsesController,
    EmbeddingsController,
    ModelsController,
  ],
  providers: [GatewayService],
})
export class AppModule {}
