import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HealthController } from '../health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let mockGateway: any;
  let mockRegistry: any;
  let mockPolicy: any;
  let mockReloader: any;
  let mockModelDiscovery: any;

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

    mockReloader = { reload: mock() };
    mockModelDiscovery = { backfillProviderByName: mock(async () => 0) };

    controller = new HealthController(
      mockGateway,
      mockRegistry,
      mockPolicy,
      mockReloader,
      mockModelDiscovery,
    );
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
        { provider: 'prov-2', status: 'down', latencyMs: 0, error: 'Timeout' },
      ]);

      mockPolicy.getCircuitBreakerState.mockReturnValue({ isOpen: true, failures: 5 });

      const res = await controller.providersHealth();

      expect(res.status).toBe('degraded');
      expect(res.providers).toHaveLength(2);
      expect(res.providers[1]).toEqual({
        provider: 'prov-2',
        status: 'down',
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

  describe('providersReload', () => {
    it('returns the reconciliation report from the reloader', async () => {
      mockReloader.reload.mockReturnValue({
        path: '/tmp/sirius-providers.yaml',
        added: ['openai'],
        removed: ['anthropic'],
        kept: ['together'],
        skipped: [],
      });
      const res = await controller.providersReload();
      expect(res.ok).toBe(true);
      expect(res.path).toBe('/tmp/sirius-providers.yaml');
      expect(res.added).toEqual(['openai']);
      expect(res.removed).toEqual(['anthropic']);
      expect(res.kept).toEqual(['together']);
      expect(res.skipped).toEqual([]);
      expect(res.timestamp).toBeDefined();
      // Both newly-added AND still-present ("kept") providers should
      // have their models backfilled. Steady-state reloads return
      // `added: []` because the yaml hasn't changed, but the
      // upstream's model list may have — without covering `kept[]`
      // discovery never re-runs after boot.
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledWith(
        'openai',
      );
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledWith(
        'together',
      );
      // `removed` + `skipped` never get backfilled.
      expect(
        mockModelDiscovery.backfillProviderByName,
      ).not.toHaveBeenCalledWith('anthropic');
    });

    it('backfills every kept provider on a steady-state reload (added: [])', async () => {
      // Repro of the ConfigMap-mounted gap: identical yaml, so the
      // reload returns `added: []` and `kept: [...]`. Routing must
      // still pick up any upstream-side model changes without a pod
      // restart.
      mockReloader.reload.mockReturnValue({
        path: '/etc/sirius/providers.yaml',
        added: [],
        removed: [],
        kept: ['local-llm', 'together', 'openai-compat-node'],
        skipped: [],
      });
      await controller.providersReload();
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledTimes(
        3,
      );
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledWith(
        'local-llm',
      );
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledWith(
        'together',
      );
      expect(mockModelDiscovery.backfillProviderByName).toHaveBeenCalledWith(
        'openai-compat-node',
      );
    });

    it('surfaces skipped entries (malformed yaml rows) on the report', async () => {
      mockReloader.reload.mockReturnValue({
        path: '/tmp/x.yaml',
        added: [],
        removed: [],
        kept: [],
        skipped: [{ name: 'broken', reason: 'has no baseUrl and no default' }],
      });
      const res = await controller.providersReload();
      expect(res.skipped).toEqual([
        { name: 'broken', reason: 'has no baseUrl and no default' },
      ]);
      // Skipped entries never registered, so they must not be
      // backfilled.
      expect(
        mockModelDiscovery.backfillProviderByName,
      ).not.toHaveBeenCalledWith('broken');
    });
  });
});