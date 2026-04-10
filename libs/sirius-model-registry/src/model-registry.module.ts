import { Module } from '@nestjs/common';
import { ModelRegistryService } from './model-registry.service.js';

@Module({
  providers: [ModelRegistryService],
  exports: [ModelRegistryService],
})
export class ModelRegistryModule {}
