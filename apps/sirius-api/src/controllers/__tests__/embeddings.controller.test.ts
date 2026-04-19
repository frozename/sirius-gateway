import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { EmbeddingsController } from '../embeddings.controller';
import { HttpException } from '@nestjs/common';

describe('EmbeddingsController', () => {
  let controller: EmbeddingsController;
  let mockGateway: any;
  let mockCompat: any;
  let mockUsageRecorder: any;
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    mockGateway = {
      createEmbeddings: mock(),
    };

    mockCompat = {
      parseEmbeddingRequest: mock(),
      formatEmbeddingResponse: mock(),
      formatError: mock(),
    };

    mockUsageRecorder = { record: mock() };

    controller = new EmbeddingsController(mockGateway, mockCompat, mockUsageRecorder);

    mockReq = { id: 'req-123' };

    mockRes = {
      header: mock().mockReturnThis(),
      status: mock().mockReturnThis(),
      send: mock().mockReturnThis(),
    };
  });

  describe('createEmbeddings', () => {
    it('calls compat -> gateway -> compat -> res.send()', async () => {
      const body = { input: 'test', model: 'test-model' };
      const parsedReq = { input: ['test'], model: 'test-model' };
      const gatewayRes = {
        data: [],
        provider: 'openai',
        model: 'text-embedding-3-small',
        usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
        latencyMs: 50,
      };
      const formattedRes = { object: 'list', data: [] };

      mockCompat.parseEmbeddingRequest.mockReturnValue(parsedReq);
      mockGateway.createEmbeddings.mockResolvedValue(gatewayRes);
      mockCompat.formatEmbeddingResponse.mockReturnValue(formattedRes);

      await controller.createEmbeddings(body as any, mockReq, mockRes);

      expect(mockCompat.parseEmbeddingRequest).toHaveBeenCalledWith(body, 'req-123');
      expect(mockGateway.createEmbeddings).toHaveBeenCalledWith(parsedReq);
      expect(mockCompat.formatEmbeddingResponse).toHaveBeenCalledWith(gatewayRes);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith(formattedRes);
      expect(mockUsageRecorder.record).toHaveBeenCalledTimes(1);
      expect(mockUsageRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          model: 'text-embedding-3-small',
          kind: 'embedding',
          promptTokens: 100,
          totalTokens: 100,
          latencyMs: 50,
          requestId: 'req-123',
        }),
      );
    });

    it('sets X-Request-Id generated if req.id is missing', async () => {
      mockReq.id = undefined;
      const parsedReq = { input: ['test'], model: 'test' };
      mockCompat.parseEmbeddingRequest.mockReturnValue(parsedReq);
      mockGateway.createEmbeddings.mockResolvedValue({
        provider: 'x',
        model: 'y',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      });
      
      await controller.createEmbeddings({} as any, mockReq, mockRes);
      
      const reqId = mockCompat.parseEmbeddingRequest.mock.calls[0][1];
      expect(reqId).toBeDefined();
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', reqId);
    });

    it('catches HttpException', async () => {
      mockCompat.parseEmbeddingRequest.mockImplementation(() => {
        throw new HttpException('Bad Request', 400);
      });

      await controller.createEmbeddings({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith('Bad Request');
    });

    it('catches generic errors', async () => {
      mockCompat.parseEmbeddingRequest.mockImplementation(() => {
        throw new Error('Some error');
      });
      mockCompat.formatError.mockReturnValue({ error: 'formatted' });

      await controller.createEmbeddings({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockCompat.formatError).toHaveBeenCalledWith(500, 'Some error');
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'formatted' });
    });
  });
});