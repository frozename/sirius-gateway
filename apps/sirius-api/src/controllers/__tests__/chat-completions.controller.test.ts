import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { ChatCompletionsController } from '../chat-completions.controller';
import { HttpException } from '@nestjs/common';

describe('ChatCompletionsController', () => {
  let controller: ChatCompletionsController;
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
      parseChatCompletionRequest: mock(),
      formatChatCompletionResponse: mock(),
      formatFirstStreamChunk: mock(),
      formatStreamChunk: mock(),
      formatSSE: mock(),
      formatSSEDone: mock(),
      formatError: mock(),
    };

    controller = new ChatCompletionsController(mockGateway, mockCompat);

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
      const body = { model: 'test' };
      const parsedReq = { model: 'test', stream: false };
      const gatewayRes = { id: 'res-1' };
      const formattedRes = { id: 'formatted-1' };

      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      mockGateway.createResponse.mockResolvedValue(gatewayRes);
      mockCompat.formatChatCompletionResponse.mockReturnValue(formattedRes);

      await controller.chatCompletions(body as any, mockReq, mockRes);

      expect(mockCompat.parseChatCompletionRequest).toHaveBeenCalledWith(body, 'req-123');
      expect(mockGateway.createResponse).toHaveBeenCalledWith(parsedReq);
      expect(mockCompat.formatChatCompletionResponse).toHaveBeenCalledWith(gatewayRes);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith(formattedRes);
    });

    it('sets X-Request-Id generated if req.id is missing', async () => {
      mockReq.id = undefined;
      const parsedReq = { model: 'test', stream: false };
      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      mockGateway.createResponse.mockResolvedValue({});
      
      await controller.chatCompletions({} as any, mockReq, mockRes);
      
      const reqId = mockCompat.parseChatCompletionRequest.mock.calls[0][1];
      expect(reqId).toBeDefined();
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', reqId);
    });

    it('catches HttpException', async () => {
      mockCompat.parseChatCompletionRequest.mockImplementation(() => {
        throw new HttpException('Bad Request', 400);
      });

      await controller.chatCompletions({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockRes.send).toHaveBeenCalledWith('Bad Request');
    });

    it('catches generic errors', async () => {
      mockCompat.parseChatCompletionRequest.mockImplementation(() => {
        throw new Error('Some error');
      });
      mockCompat.formatError.mockReturnValue({ error: 'formatted' });

      await controller.chatCompletions({} as any, mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.header).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      expect(mockCompat.formatError).toHaveBeenCalledWith(500, 'Some error');
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'formatted' });
    });
  });

  describe('streaming', () => {
    it('sets SSE headers', async () => {
      const parsedReq = { model: 'test', stream: true };
      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      
      async function* emptyStream() {}
      mockGateway.streamResponse.mockReturnValue(emptyStream());

      await controller.chatCompletions({} as any, mockReq, mockRes);

      expect(mockResRaw.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': 'req-123',
      });
    });

    it('writes first chunk and content chunks', async () => {
      const parsedReq = { model: 'test', stream: true };
      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'content_delta', delta: 'Hello' };
        yield { type: 'content_delta', delta: ' World' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());
      
      mockCompat.formatFirstStreamChunk.mockReturnValue({ role: 'assistant' });
      mockCompat.formatStreamChunk.mockImplementation((e: any) => ({ chunk: e.delta }));
      mockCompat.formatSSE.mockImplementation((c: any) => `data: ${JSON.stringify(c)}\n\n`);
      mockCompat.formatSSEDone.mockReturnValue('data: [DONE]\n\n');

      await controller.chatCompletions({} as any, mockReq, mockRes);

      expect(mockCompat.formatFirstStreamChunk).toHaveBeenCalled();
      
      // Should write first chunk SSE
      expect(mockResRaw.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ role: 'assistant' })}\n\n`);
      
      // Should write delta chunks
      expect(mockResRaw.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ chunk: 'Hello' })}\n\n`);
      expect(mockResRaw.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ chunk: ' World' })}\n\n`);
      
      // Should write done
      expect(mockResRaw.write).toHaveBeenCalledWith('data: [DONE]\n\n');
      expect(mockResRaw.end).toHaveBeenCalled();
    });

    it('writes error chunk and breaks stream', async () => {
      const parsedReq = { model: 'test', stream: true };
      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'content_delta', delta: 'Hello' };
        yield { type: 'error', error: 'Test error' };
        yield { type: 'content_delta', delta: ' Never reached' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());
      
      mockCompat.formatFirstStreamChunk.mockReturnValue({ role: 'assistant' });
      mockCompat.formatStreamChunk.mockImplementation((e: any) => ({ chunk: e.delta }));
      mockCompat.formatSSE.mockImplementation((c: any) => `data: ${JSON.stringify(c)}\n\n`);
      mockCompat.formatSSEDone.mockReturnValue('data: [DONE]\n\n');

      await controller.chatCompletions({} as any, mockReq, mockRes);

      // Should write Hello chunk
      expect(mockResRaw.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ chunk: 'Hello' })}\n\n`);
      
      const calls = mockResRaw.write.mock.calls;
      
      // Check that the error chunk is formatted
      const errorCall = calls.find(call => call[0].includes('finish_reason":"error"'));
      expect(errorCall).toBeDefined();

      const neverReachedCall = calls.find(call => call[0].includes('Never reached'));
      expect(neverReachedCall).toBeUndefined();

      expect(mockResRaw.write).toHaveBeenCalledWith('data: [DONE]\n\n');
      expect(mockResRaw.end).toHaveBeenCalled();
    });

    it('stops writing when res.raw close fires', async () => {
      const parsedReq = { model: 'test', stream: true };
      mockCompat.parseChatCompletionRequest.mockReturnValue(parsedReq);
      
      async function* mockStream() {
        yield { type: 'content_delta', delta: '1' };
        mockResRaw._closeCb();
        yield { type: 'content_delta', delta: '2' };
      }
      mockGateway.streamResponse.mockReturnValue(mockStream());
      
      mockCompat.formatFirstStreamChunk.mockReturnValue({});
      mockCompat.formatStreamChunk.mockImplementation((e: any) => ({ chunk: e.delta }));
      mockCompat.formatSSE.mockImplementation((c: any) => `data: ${JSON.stringify(c)}\n\n`);
      mockCompat.formatSSEDone.mockReturnValue('data: [DONE]\n\n');

      await controller.chatCompletions({} as any, mockReq, mockRes);

      const calls = mockResRaw.write.mock.calls;
      const secondChunkCall = calls.find(call => call[0].includes('chunk":"2"'));
      expect(secondChunkCall).toBeUndefined();
      
      expect(mockResRaw.write).toHaveBeenCalledWith('data: [DONE]\n\n');
      expect(mockResRaw.end).toHaveBeenCalled();
    });
  });
});