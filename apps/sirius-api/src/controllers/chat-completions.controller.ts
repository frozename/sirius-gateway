import { Body, Controller, HttpCode, Post, Req, Res, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAiChatCompletionRequest } from '@sirius/compat-openai';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { GatewayService } from '../gateway.service';

@Controller('v1')
export class ChatCompletionsController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly compat: OpenAiCompatService,
  ) {}

  @Post('chat/completions')
  @HttpCode(200)
  async chatCompletions(
    @Body() body: OpenAiChatCompletionRequest,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const requestId = (req.id as string) ?? randomUUID();

    try {
      const request = this.compat.parseChatCompletionRequest(body, requestId);

      if (request.stream) {
        res.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Request-Id': requestId,
        });

        const responseId = `chatcmpl-${randomUUID()}`;
        const stream = this.gateway.streamResponse(request);

        let firstChunkEmitted = false;
        let aborted = false;

        res.raw.on('close', () => {
          aborted = true;
        });

        for await (const event of stream) {
          if (aborted) break;

          if (!firstChunkEmitted && (event.type === 'content_delta' || event.type === 'tool_call_delta')) {
            const firstChunk = this.compat.formatFirstStreamChunk(responseId, request.model);
            res.raw.write(this.compat.formatSSE(firstChunk));
            firstChunkEmitted = true;
          }

          if (event.type === 'error') {
            const errorChunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'error',
                },
              ],
            };
            res.raw.write(this.compat.formatSSE(errorChunk));
            break;
          }
          const chunk = this.compat.formatStreamChunk(
            event,
            responseId,
            request.model,
          );
          if (chunk) {
            res.raw.write(this.compat.formatSSE(chunk));
          }
        }

        res.raw.write(this.compat.formatSSEDone());
        res.raw.end();
      } else {
        const response = await this.gateway.createResponse(request);
        const formatted = this.compat.formatChatCompletionResponse(response);
        res.header('X-Request-Id', requestId);
        return res.send(formatted);
      }
    } catch (error) {
      if (error instanceof HttpException) {
        res.status(error.getStatus()).header('X-Request-Id', requestId);
        return res.send(error.getResponse());
      }
      const message =
        error instanceof Error ? error.message : 'Internal server error';
      const formatted = this.compat.formatError(500, message);
      res.status(500).header('X-Request-Id', requestId);
      return res.send(formatted);
    }
  }
}
