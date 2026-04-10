import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider-registry.js';

@Global()
@Module({
  providers: [ProviderRegistry],
  exports: [ProviderRegistry],
})
export class SiriusCoreModule {}
