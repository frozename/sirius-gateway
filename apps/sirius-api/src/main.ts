import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GatewayExceptionFilter } from './exception.filter';
import { ModelRegistryService } from '@sirius/model-registry';
import { RoutingService } from '@sirius/routing';
import { ProviderRegistry } from '@sirius/core';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      requestTimeout: 120_000,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GatewayExceptionFilter());

  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>('SIRIUS_CORS_ORIGIN', '*');

  app.enableCors({ origin: corsOrigin });

  // Propagate X-Request-Id on responses
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('X-Request-Id', request.id);
    done();
  });

  app.enableShutdownHooks();

  const port = config.get<number>('SIRIUS_PORT', 3000);
  const host = config.get<string>('SIRIUS_HOST', '0.0.0.0');

  await app.listen(port, host);

  const logger = app.get(Logger);
  const modelRegistry = app.get(ModelRegistryService);
  const routingService = app.get(RoutingService);
  const providerRegistry = app.get(ProviderRegistry);

  const providers = providerRegistry.getNames();
  const models = modelRegistry.listModels();

  logger.log(`Sirius Gateway started on http://${host}:${port}`);
  logger.log(`Active Providers: ${providers.join(', ')}`);
  logger.log(`Configured Models: ${models.length}`);
  logger.log(`Default Routing Strategy: ${routingService.getDefaultStrategy()}`);
}

bootstrap();
