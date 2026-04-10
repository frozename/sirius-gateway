import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { ProviderRegistry } from '@sirius/core';
import { MockProvider } from '../../../../libs/sirius-core/src/__tests__/fixtures';

export async function createE2eApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ProviderRegistry)
    .useValue({
      get: (name: string) => new MockProvider(name),
      getAll: () => [new MockProvider('openai'), new MockProvider('anthropic')],
      register: () => {},
    })
    .compile();

  const app = moduleRef.createNestApplication(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  
  return app;
}
