import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Public } from '@sirius/auth';
import { ModelRegistryService } from '@sirius/model-registry';
import { PolicyService } from '@sirius/policy';
import { FromFileReloadService } from '@sirius/provider-fromfile';
import { GatewayService } from '../gateway.service';

@Controller()
export class HealthController {
  private readonly startTime = Date.now();

  constructor(
    private readonly gateway: GatewayService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly policyService: PolicyService,
    private readonly reloader: FromFileReloadService,
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

  @Post('providers/reload')
  @HttpCode(200)
  async providersReload() {
    // Re-scans the sirius-providers.yaml file on disk + reconciles
    // the ProviderRegistry (add new entries, unregister deleted
    // ones, keep pre-existing unchanged). Returns the diff so
    // operators + the cost-guardian tier-3 path can audit what
    // changed. Public-auth-exempt for the same reason /health is:
    // infra bits can't rely on an API token.
    const result = this.reloader.reload();
    return {
      ok: true,
      path: result.path,
      added: result.added,
      removed: result.removed,
      kept: result.kept,
      skipped: result.skipped,
      timestamp: new Date().toISOString(),
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
