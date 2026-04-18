import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ResponsesController } from '../responses.controller';
import { HttpException } from '@nestjs/common';

describe('ResponsesController', () => {
  let controller: ResponsesController;
  let mockGateway: any;
  let mockCompat: any;
  let mockReq: any;
  let mockRes: any;
  let mockResRaw: any;

  beforeEach(() => {
    mockGateway = {
      createResponse: mock(),
      streamResponse: mock(),
    };

    mockCompat = {
      parseResponsesRequest: mock(),
      formatResponsesResponse: mock(),
      formatError: mock(),
    };

    controller = new ResponsesController(mockGateway, mockCompat);

    mockReq = { id: 'req-123' };

    mockResRaw = {
      writeHead: mock(),
      write: mock(),
      end: mock(),
      on: mock((event, cb) => {
        if (event === 'close') {
          mockResRaw._closeCb = cb;
        }
      }),
    };

    mockRes = {
      header: mock().mockReturnThis(),
      status: mock().mockReturnThis(),
      send: mock().mockReturnThis(),
      raw: mockResRaw,
    };
  });

  describe('non-streaming', () => {
    it('calls compat -> gateway -> compat -> res.send()', async () => {
      const body = { input: 'test' };
      const parsedReq = { input: 'test', stream: false };
      const gatewayRes = { id: 'res-1' };
      const formattedRes = { id: 'formatted-1' };

      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      mockGateway.createResponse.mockResolvedValue(gatewayRes);
      mockCompat.formatResponsesResponse.mockReturnValue(formattedRes);

      await controller.responses(body as any, mockReq, mockRes);

      expect(mockCompat.parseResponsesRequest).toHaveBeenCalledWith(body, 'req-123');
      expect(mockGateway.createResponse).toHaveBeenCalledWith(parsedReq);
      expect(mockCompat.formatResponsesResponse).toHaveBeenCalledWith(gatewayRes);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith(formattedRes);
    });

    it('sets X-Request-Id generated if req.id is missing', async () => {
      mockReq.id = undefined;
      const parsedReq = { stream: false };
      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      mockGateway.createResponse.mockResolvedValue({});
      
      await controller.responses({} as any, mockReq, mockRes);
      
      const reqId = mockCompat.parseResponsesRequest.mock.calls[0][1];
      expect(reqId).toBeDefined();
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', reqId);
    });

    it('catches HttpException', async () => {
      mockCompat.parseResponsesRequest.mockImplementation(() => {
        throw new HttpException('Bad Request', 400);
      });

      await controller.responses({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith('Bad Request');
    });

    it('catches generic errors', async () => {
      mockCompat.parseResponsesRequest.mockImplementation(() => {
        throw new Error('Some error');
      });
      mockCompat.formatError.mockReturnValue({ error: 'formatted' });

      await controller.responses({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockCompat.formatError).toHaveBeenCalledWith(500, 'Some error');
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'formatted' });
    });
  });

  describe('streaming', () => {
    it('sets SSE headers', async () => {
      const parsedReq = { stream: true };
      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      
      async function* emptyStream() {}
      mockGateway.streamResponse.mockReturnValue(emptyStream());

      await controller.responses({} as any, mockReq, mockRes);

      expect(mockResRaw.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': 'req-123',
      });
    });

    it('writes content_delta and done', async () => {
      const parsedReq = { stream: true };
      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'content_delta', delta: 'Hello' };
        yield { type: 'done' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());

      await controller.responses({} as any, mockReq, mockRes);

      const calls = mockResRaw.write.mock.calls;
      const deltaCall = calls.find((call: unknown[]) => String(call[0]).includes('response.output_text.delta'));
      expect(deltaCall).toBeDefined();
      expect(deltaCall[0]).toContain('"delta":"Hello"');

      const doneCall = calls.find((call: unknown[]) => String(call[0]).includes('response.completed'));
      expect(doneCall).toBeDefined();

      expect(mockResRaw.end).toHaveBeenCalled();
    });

    it('writes error and breaks stream', async () => {
      const parsedReq = { stream: true };
      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'error', error: 'Stream error' };
        yield { type: 'content_delta', delta: 'Unreached' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());

      await controller.responses({} as any, mockReq, mockRes);

      const calls = mockResRaw.write.mock.calls;
      const errorCall = calls.find((call: unknown[]) => String(call[0]).includes('"error":{"message":"Stream error"}'));
      expect(errorCall).toBeDefined();

      const unreachedCall = calls.find((call: unknown[]) => String(call[0]).includes('Unreached'));
      expect(unreachedCall).toBeUndefined();

      expect(mockResRaw.end).toHaveBeenCalled();
    });

    it('stops writing when res.raw close fires', async () => {
      const parsedReq = { stream: true };
      mockCompat.parseResponsesRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'content_delta', delta: '1' };
        mockResRaw._closeCb();
        yield { type: 'content_delta', delta: '2' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());

      await controller.responses({} as any, mockReq, mockRes);

      const calls = mockResRaw.write.mock.calls;
      const firstChunkCall = calls.find((call: unknown[]) => String(call[0]).includes('"delta":"1"'));
      expect(firstChunkCall).toBeDefined();
      
      const secondChunkCall = calls.find((call: unknown[]) => String(call[0]).includes('"delta":"2"'));
      expect(secondChunkCall).toBeUndefined();
      
      expect(mockResRaw.end).toHaveBeenCalled();
    });
  });
});