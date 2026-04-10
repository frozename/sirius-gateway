import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HealthController } from '../health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let mockGateway: any;
  let mockRegistry: any;
  let mockPolicy: any;

  beforeEach(() => {
    mockGateway = {
      getProviderHealth: mock(),
    };

    mockRegistry = {
      listModels: mock(),
    };

    mockPolicy = {
      getCircuitBreakerState: mock(),
    };

    controller = new HealthController(mockGateway, mockRegistry, mockPolicy);
  });

  describe('health', () => {
    it('returns ok with metadata and provider counts', async () => {
      mockRegistry.listModels.mockReturnValue([
        { provider: 'prov-1' },
        { provider: 'prov-1' },
        { provider: 'prov-2' },
      ]);

      const res = await controller.health();

      expect(res.status).toBe('ok');
      expect(res.service).toBe('sirius-gateway');
      expect(res.version).toBe('0.1.0');
      expect(res.stats.registeredProviders).toBe(2);
      expect(res.stats.configuredModels).toBe(3);
      expect(res.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(res.timestamp).toBeDefined();
    });

    it('returns 0 counts when registry is empty', async () => {
      mockRegistry.listModels.mockReturnValue([]);
      const res = await controller.health();
      expect(res.stats.registeredProviders).toBe(0);
      expect(res.stats.configuredModels).toBe(0);
    });
  });

  describe('providersHealth', () => {
    it('aggregates health and circuit breaker state (all healthy)', async () => {
      mockGateway.getProviderHealth.mockResolvedValue([
        { provider: 'prov-1', status: 'healthy', latencyMs: 100 },
        { provider: 'prov-2', status: 'healthy', latencyMs: 150 },
      ]);

      mockPolicy.getCircuitBreakerState.mockImplementation((provider: string) => {
        if (provider === 'prov-1') return { isOpen: false, failures: 0 };
        return { isOpen: false, failures: 1 };
      });

      const res = await controller.providersHealth();

      expect(res.status).toBe('ok');
      expect(res.providers).toHaveLength(2);
      expect(res.providers[0]).toEqual({
        provider: 'prov-1',
        status: 'healthy',
        latencyMs: 100,
        circuitBreaker: { isOpen: false, failures: 0 },
        error: undefined,
      });
      expect(res.providers[1]).toEqual({
        provider: 'prov-2',
        status: 'healthy',
        latencyMs: 150,
        circuitBreaker: { isOpen: false, failures: 1 },
        error: undefined,
      });
    });

    it('returns degraded when a provider is unhealthy', async () => {
      mockGateway.getProviderHealth.mockResolvedValue([
        { provider: 'prov-1', status: 'healthy', latencyMs: 100 },
        { provider: 'prov-2', status: 'unhealthy', latencyMs: 0, error: 'Timeout' },
      ]);

      mockPolicy.getCircuitBreakerState.mockReturnValue({ isOpen: true, failures: 5 });

      const res = await controller.providersHealth();

      expect(res.status).toBe('degraded');
      expect(res.providers).toHaveLength(2);
      expect(res.providers[1]).toEqual({
        provider: 'prov-2',
        status: 'unhealthy',
        latencyMs: 0,
        circuitBreaker: { isOpen: true, failures: 5 },
        error: 'Timeout',
      });
    });
    
    it('returns degraded when a provider is degraded', async () => {
      mockGateway.getProviderHealth.mockResolvedValue([
        { provider: 'prov-1', status: 'degraded', latencyMs: 1000 },
      ]);

      mockPolicy.getCircuitBreakerState.mockReturnValue({ isOpen: false, failures: 2 });

      const res = await controller.providersHealth();

      expect(res.status).toBe('degraded');
      expect(res.providers).toHaveLength(1);
    });
  });
});