import { Module } from '@nestjs/common';
import { ModelRegistryModule } from '@sirius/model-registry';
import { ObservabilityModule } from '@sirius/observability';
import { RoutingService } from './routing.service.js';
import { PinnedStrategy } from './strategies/pinned.strategy.js';
import { FastestStrategy } from './strategies/fastest.strategy.js';
import { CheapestStrategy } from './strategies/cheapest.strategy.js';
import { BalancedStrategy } from './strategies/balanced.strategy.js';
import { LocalFirstStrategy } from './strategies/local-first.strategy.js';
import { PrivacyFirstStrategy } from './strategies/privacy-first.strategy.js';

@Module({
  imports: [ModelRegistryModule, ObservabilityModule],
  providers: [
    RoutingService,
    PinnedStrategy,
    FastestStrategy,
    CheapestStrategy,
    BalancedStrategy,
    LocalFirstStrategy,
    PrivacyFirstStrategy,
  ],
  exports: [RoutingService],
})
export class RoutingModule {}
