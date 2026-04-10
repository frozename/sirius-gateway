import { Controller, Get } from '@nestjs/common';
import { Public } from '@sirius/auth';
import { ModelRegistryService } from '@sirius/model-registry';
import { PolicyService } from '@sirius/policy';
import { GatewayService } from '../gateway.service';

@Controller()
export class HealthController {
  private readonly startTime = Date.now();

  constructor(
    private readonly gateway: GatewayService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly policyService: PolicyService,
  ) {}

  @Get('health')
  @Public()
  async health() {
    const models = this.modelRegistry.listModels();
    const providers = new Set(models.map((m) => m.provider));

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'sirius-gateway',
      version: '0.1.0',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      stats: {
        registeredProviders: providers.size,
        configuredModels: models.length,
      },
    };
  }

  @Get('providers/health')
  @Public()
  async providersHealth() {
    const health = await this.gateway.getProviderHealth();

    const allHealthy = health.every((h) => h.status === 'healthy');

    return {
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      providers: health.map((h) => {
        const circuit = this.policyService.getCircuitBreakerState(h.provider);
        return {
          provider: h.provider,
          status: h.status,
          latencyMs: h.latencyMs,
          circuitBreaker: {
            isOpen: circuit.isOpen,
            failures: circuit.failures,
          },
          error: h.error,
        };
      }),
    };
  }
}
