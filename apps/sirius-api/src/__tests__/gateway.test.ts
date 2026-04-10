import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { GatewayService } from '../gateway.service';
import {
  makeUnifiedRequest,
  makeUnifiedResponse,
  makeEmbeddingRequest,
  makeEmbeddingResponse,
  makeStreamEvent,
  MockProvider,
} from '../../../../libs/sirius-core/src/__tests__/fixtures';

describe('GatewayService', () => {
  let gatewayService: GatewayService;
  let mockProviderRegistry: any;
  let mockRoutingService: any;
  let mockPolicyService: any;
  let mockConfigService: any;
  let mockStreamingObserver: any;
  let mockLatencyTracker: any;

  beforeEach(() => {
    mockProviderRegistry = {
      get: mock((name: string) => {
        if (name === 'p1') return new MockProvider('p1');
        if (name === 'p2') return new MockProvider('p2');
        return null;
      }),
      getAll: mock(() => [new MockProvider('p1'), new MockProvider('p2')]),
    };

    mockRoutingService = {
      route: mock((req: any) => ({
        selectedProvider: 'p1',
        selectedModel: 'm1',
        strategy: 'test-strategy',
        fallbackChain: ['p2/m1'],
      })),
    };

    mockPolicyService = {
      executeWithPolicy: mock((provider: string, op: any) => op()),
      executeStreamWithPolicy: mock((provider: string, op: any) => op()),
    };

    mockConfigService = {
      get: mock((key: string, defaultValue: any) => defaultValue),
    };

    mockStreamingObserver = {
      observe: mock((stream: any) => stream),
    };

    mockLatencyTracker = {
      record: mock(),
      getAverageLatency: mock((provider: string) => null),
    };

    gatewayService = new GatewayService(
      mockProviderRegistry,
      mockRoutingService,
      mockPolicyService,
      mockConfigService,
      mockStreamingObserver,
      mockLatencyTracker,
    );
  });

  describe('createResponse', () => {
    it('succeeds with primary provider', async () => {
      const request = makeUnifiedRequest();
      const response = await gatewayService.createResponse(request);

      expect(response.provider).toBe('p1');
      expect(response._gatewayMeta.fallbackUsed).toBe(false);
      expect(mockRoutingService.route).toHaveBeenCalled();
    });

    it('uses fallback if primary fails', async () => {
      const p1 = new MockProvider('p1');
      p1.setError(new Error('P1 Failed'));
      const p2 = new MockProvider('p2');
      
      mockProviderRegistry.get = mock((name: string) => {
        if (name === 'p1') return p1;
        if (name === 'p2') return p2;
        return null;
      });

      const request = makeUnifiedRequest();
      const response = await gatewayService.createResponse(request);

      expect(response.provider).toBe('p2');
      expect(response._gatewayMeta.fallbackUsed).toBe(true);
    });

    it('throws if all providers fail', async () => {
      const p1 = new MockProvider('p1');
      p1.setError(new Error('P1 Failed'));
      const p2 = new MockProvider('p2');
      p2.setError(new Error('P2 Failed'));
      
      mockProviderRegistry.get = mock((name: string) => {
        if (name === 'p1') return p1;
        if (name === 'p2') return p2;
        return null;
      });

      const request = makeUnifiedRequest();
      await expect(gatewayService.createResponse(request)).rejects.toThrow('P2 Failed');
    });
  });

  describe('streamResponse', () => {
    it('streams from primary provider', async () => {
      const request = makeUnifiedRequest({ stream: true });
      const events = [];
      for await (const event of gatewayService.streamResponse(request)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.type).toBe('content_delta');
    });

    it('streams from fallback if primary fails', async () => {
      const p1 = new MockProvider('p1');
      p1.setError(new Error('P1 Stream Fail'));
      const p2 = new MockProvider('p2');
      p2.setStream([makeStreamEvent({ type: 'content_delta', delta: 'from p2' }), makeStreamEvent({ type: 'done' })]);
      
      mockProviderRegistry.get = mock((name: string) => {
        if (name === 'p1') return p1;
        if (name === 'p2') return p2;
        return null;
      });

      const request = makeUnifiedRequest({ stream: true });
      const events = [];
      for await (const event of gatewayService.streamResponse(request)) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: 'content_delta', delta: 'from p2' });
    });
  });

  describe('createEmbeddings', () => {
    it('routes to embedding provider', async () => {
      mockRoutingService.route = mock(() => ({
        selectedProvider: 'p1',
        selectedModel: 'emb-1',
      }));

      const request = makeEmbeddingRequest();
      const response = await gatewayService.createEmbeddings(request);

      expect(response.provider).toBe('p1');
      expect(mockRoutingService.route).toHaveBeenCalledWith(expect.objectContaining({ embeddings: true }));
    });
  });

  describe('listModels', () => {
    it('aggregates models from all providers', async () => {
      const models = await gatewayService.listModels();
      expect(models.length).toBe(2); // One from p1, one from p2 (MockProvider default)
      expect(models[0]!.provider).toBe('p1');
      expect(models[1]!.provider).toBe('p2');
    });

    it('handles partial failures during model listing', async () => {
      const p1 = new MockProvider('p1');
      const p2 = {
        listModels: async () => { throw new Error('P2 list failed'); }
      };
      mockProviderRegistry.getAll = mock(() => [p1, p2]);

      const models = await gatewayService.listModels();
      expect(models.length).toBe(1);
      expect(models[0]!.provider).toBe('p1');
    });
  });
});


