import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ModelsController } from '../models.controller';

describe('ModelsController', () => {
  let controller: ModelsController;
  let mockGateway: any;
  let mockCompat: any;
  let mockRegistry: any;
  let mockRes: any;

  beforeEach(() => {
    mockGateway = {
      listModels: mock(),
    };

    mockCompat = {
      formatModelList: mock(),
      formatError: mock(),
    };

    mockRegistry = {
      listModels: mock(),
      getCapabilities: mock(),
    };

    controller = new ModelsController(mockGateway, mockCompat, mockRegistry);

    mockRes = {
      status: mock().mockReturnThis(),
      send: mock().mockReturnThis(),
    };
  });

  describe('listModels', () => {
    it('merges gateway with registry and formats', async () => {
      const gatewayModels = [{ id: 'model-a', provider: 'prov-1' }];
      const registryModels = [{ modelId: 'model-b', provider: 'prov-2' }];
      const formatted = { data: [] };

      mockGateway.listModels.mockResolvedValue(gatewayModels);
      mockRegistry.listModels.mockReturnValue(registryModels);
      mockCompat.formatModelList.mockReturnValue(formatted);

      await controller.listModels(mockRes);

      const expectedMerged = [
        { id: 'model-a', provider: 'prov-1' },
        { id: 'model-b', provider: 'prov-2', ownedBy: 'prov-2' },
      ];

      expect(mockCompat.formatModelList).toHaveBeenCalledWith(expectedMerged);
      expect(mockRes.send).toHaveBeenCalledWith(formatted);
    });

    it('deduplicates by id', async () => {
      const gatewayModels = [{ id: 'model-a', provider: 'prov-1' }];
      const registryModels = [
        { modelId: 'model-a', provider: 'prov-2' },
        { modelId: 'model-b', provider: 'prov-3' },
      ];

      mockGateway.listModels.mockResolvedValue(gatewayModels);
      mockRegistry.listModels.mockReturnValue(registryModels);
      mockCompat.formatModelList.mockImplementation((models: any) => models);

      await controller.listModels(mockRes);

      const calls = mockCompat.formatModelList.mock.calls;
      const mergedModels = calls[0][0];

      expect(mergedModels).toHaveLength(2);
      expect(mergedModels[0].id).toBe('model-a');
      expect(mergedModels[0].provider).toBe('prov-1');
      expect(mergedModels[1].id).toBe('model-b');
    });

    it('catches errors', async () => {
      mockGateway.listModels.mockImplementation(() => {
        throw new Error('Test error');
      });
      mockCompat.formatError.mockReturnValue({ error: 'test error' });

      await controller.listModels(mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockCompat.formatError).toHaveBeenCalledWith(500, 'Test error');
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'test error' });
    });
  });

  describe('getModel', () => {
    it('returns model with capability lookup', async () => {
      mockRegistry.getCapabilities.mockReturnValue({ modelId: 'model-c', provider: 'prov-4' });

      await controller.getModel('model-c', mockRes);

      expect(mockRegistry.getCapabilities).toHaveBeenCalledWith('model-c');
      expect(mockRes.send).toHaveBeenCalledWith(expect.objectContaining({
        id: 'model-c',
        object: 'model',
        owned_by: 'prov-4',
      }));
    });

    it('returns 404 for unknown model', async () => {
      mockRegistry.getCapabilities.mockReturnValue(undefined);
      mockCompat.formatError.mockReturnValue({ error: 'not found' });

      await controller.getModel('unknown', mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockCompat.formatError).toHaveBeenCalledWith(404, 'Model "unknown" not found.', 'not_found_error', 'model_not_found');
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'not found' });
    });
  });
});