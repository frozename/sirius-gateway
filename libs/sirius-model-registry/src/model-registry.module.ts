import { Module } from '@nestjs/common';
import { ModelRegistryService } from './model-registry.service.js';
import { ModelDiscoveryService } from './model-discovery.service.js';

@Module({
  providers: [ModelRegistryService, ModelDiscoveryService],
  exports: [ModelRegistryService, ModelDiscoveryService],
})
export class ModelRegistryModule {}
