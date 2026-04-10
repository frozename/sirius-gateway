import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { RoutingService } from '../routing.service.js';
import { ModelRegistryService } from '../../../sirius-model-registry/src/index.js';
import { ProviderRegistry } from '../../../sirius-core/src/index.js';
import { LatencyTracker } from '../../../sirius-observability/src/index.js';
import { PinnedStrategy } from '../strategies/pinned.strategy.js';
import { FastestStrategy } from '../strategies/fastest.strategy.js';
import { CheapestStrategy } from '../strategies/cheapest.strategy.js';
import { BalancedStrategy } from '../strategies/balanced.strategy.js';
import { LocalFirstStrategy } from '../strategies/local-first.strategy.js';
import { PrivacyFirstStrategy } from '../strategies/privacy-first.strategy.js';

describe('RoutingService', () => {
  let routingService: RoutingService;
  let modelRegistryMock: any;
  let providerRegistryMock: any;
  let latencyTrackerMock: any;
  
  let pinnedStrategyMock: any;
  let fastestStrategyMock: any;
  let cheapestStrategyMock: any;
  let balancedStrategyMock: any;
  let localFirstStrategyMock: any;
  let privacyFirstStrategyMock: any;

  beforeEach(() => {
    modelRegistryMock = {
      resolveModel: mock(),
      getProvidersForModel: mock(),
      listModels: mock(),
    };

    providerRegistryMock = {
      get: mock(),
    };

    latencyTrackerMock = {
      getAverageLatency: mock(),
    };

    const createStrategyMock = (name: string) => ({
      name,
      select: mock(),
      buildFallbackChain: mock(),
    });

    pinnedStrategyMock = createStrategyMock('pinned');
    fastestStrategyMock = createStrategyMock('fastest');
    cheapestStrategyMock = createStrategyMock('cheapest');
    balancedStrategyMock = createStrategyMock('balanced');
    localFirstStrategyMock = createStrategyMock('local-first');
    privacyFirstStrategyMock = createStrategyMock('privacy-first');

    routingService = new RoutingService(
      modelRegistryMock as unknown as ModelRegistryService,
      providerRegistryMock as unknown as ProviderRegistry,
      latencyTrackerMock as unknown as LatencyTracker,
      pinnedStrategyMock as unknown as PinnedStrategy,
      fastestStrategyMock as unknown as FastestStrategy,
      cheapestStrategyMock as unknown as CheapestStrategy,
      balancedStrategyMock as unknown as BalancedStrategy,
      localFirstStrategyMock as unknown as LocalFirstStrategy,
      privacyFirstStrategyMock as unknown as PrivacyFirstStrategy,
    );
  });

  describe('route', () => {
    it('returns noRoute when model unknown', () => {
      modelRegistryMock.resolveModel.mockReturnValue(null);
      
      const decision = routingService.route({ model: 'unknown-model', stream: false });
      
      expect(modelRegistryMock.resolveModel).toHaveBeenCalledWith('unknown-model');
      expect(decision.selectedProvider).toBe('');
      expect(decision.reason).toContain('does not exist');
    });

    it('returns noRoute when no eligible candidates', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([]);
      modelRegistryMock.getProvidersForModel.mockReturnValue([]);

      const decision = routingService.route({ model: 'gpt-4', stream: false });
      
      expect(decision.selectedProvider).toBe('');
      expect(decision.reason).toContain('No eligible candidates');
    });

    it('noRoute reason lists unconfigured providers', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([]);
      modelRegistryMock.getProvidersForModel.mockReturnValue(['openai', 'azure']);

      const decision = routingService.route({ model: 'gpt-4', stream: false });
      
      expect(decision.reason).toContain("requires provider(s) 'openai, azure'");
    });

    it('uses pinned strategy by default', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({}); // Provider exists
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      const decision = routingService.route({ model: 'gpt-4', stream: false });
      
      expect(decision.strategy).toBe('pinned');
      expect(pinnedStrategyMock.select).toHaveBeenCalled();
    });

    it('uses preferred strategy when provided', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({}); // Provider exists
      fastestStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      fastestStrategyMock.buildFallbackChain.mockReturnValue([]);

      const decision = routingService.route({ model: 'gpt-4', stream: false }, 'fastest');
      
      expect(decision.strategy).toBe('fastest');
      expect(fastestStrategyMock.select).toHaveBeenCalled();
    });

    it('falls back to pinned when strategy not found', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({}); // Provider exists
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      const decision = routingService.route({ model: 'gpt-4', stream: false }, 'nonexistent');
      
      expect(decision.strategy).toBe('pinned');
      expect(pinnedStrategyMock.select).toHaveBeenCalled();
    });

    it('builds candidates filtering by capabilities', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true, streaming: false } },
        { modelId: 'gpt-4', provider: 'azure', capabilities: { chat: true, streaming: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'azure', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'gpt-4', stream: true });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.requiredCapabilities).toContain('streaming');
      expect(contextArgs.candidates).toHaveLength(1);
      expect(contextArgs.candidates[0].model.provider).toBe('azure');
    });

    it('includes latency from tracker', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      latencyTrackerMock.getAverageLatency.mockReturnValue(150);
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'gpt-4', stream: false });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.candidates[0].health.latencyMs).toBe(150);
      expect(latencyTrackerMock.getAverageLatency).toHaveBeenCalledWith('openai');
    });

    it('derives chat capability', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'gpt-4', stream: false });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.requiredCapabilities).toContain('chat');
      expect(contextArgs.requiredCapabilities).not.toContain('embeddings');
    });

    it('derives embeddings capability when embeddings=true', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'text-embedding-3' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'text-embedding-3', provider: 'openai', capabilities: { embeddings: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'text-embedding-3' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'text-embedding-3', stream: false, embeddings: true });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.requiredCapabilities).toContain('embeddings');
      expect(contextArgs.requiredCapabilities).not.toContain('chat');
    });

    it('derives streaming capability when stream=true', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true, streaming: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'gpt-4', stream: true });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.requiredCapabilities).toContain('streaming');
    });

    it('derives tools capability when tools present', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true, tools: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue({ model: { provider: 'openai', modelId: 'gpt-4' } });
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      routingService.route({ model: 'gpt-4', stream: false, tools: [{ type: 'function' }] });
      
      const contextArgs = pinnedStrategyMock.select.mock.calls[0][0];
      expect(contextArgs.requiredCapabilities).toContain('tools');
    });
    
    it('returns noRoute if strategy select returns null', () => {
      modelRegistryMock.resolveModel.mockReturnValue({ modelId: 'gpt-4' });
      modelRegistryMock.listModels.mockReturnValue([
        { modelId: 'gpt-4', provider: 'openai', capabilities: { chat: true } }
      ]);
      providerRegistryMock.get.mockReturnValue({});
      pinnedStrategyMock.select.mockReturnValue(null);
      pinnedStrategyMock.buildFallbackChain.mockReturnValue([]);

      const decision = routingService.route({ model: 'gpt-4', stream: false });
      
      expect(decision.selectedProvider).toBe('');
      expect(decision.reason).toBe('No eligible provider found');
    });
  });

  describe('getStrategy', () => {
    it('returns requested strategy', () => {
      const strategy = routingService.getStrategy('balanced');
      expect(strategy).toBe(balancedStrategyMock);
    });

    it('falls back to pinned for unknown', () => {
      const strategy = routingService.getStrategy('unknown-strategy');
      expect(strategy).toBe(pinnedStrategyMock);
    });
  });
});
