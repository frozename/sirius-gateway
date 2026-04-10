import { Body, Controller, HttpCode, Post, Req, Res, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAiResponsesRequest } from '@sirius/compat-openai';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { GatewayService } from '../gateway.service';

@Controller('v1')
export class ResponsesController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly compat: OpenAiCompatService,
  ) {}

  @Post('responses')
  @HttpCode(200)
  async responses(
    @Body() body: OpenAiResponsesRequest,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const requestId = (req.id as string) ?? randomUUID();

    try {
      const request = this.compat.parseResponsesRequest(body, requestId);

      if (request.stream) {
        res.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Request-Id': requestId,
        });

        // For the Responses API streaming, we accumulate and emit structured events
        // For now, we'll emit OpenAI-compatible SSE chunks that can be adapted
        const responseId = `resp_${randomUUID()}`;
        const stream = this.gateway.streamResponse(request);

        let aborted = false;
        res.raw.on('close', () => {
          aborted = true;
        });

        for await (const event of stream) {
          if (aborted) break;

          if (event.type === 'error') {
            res.raw.write(`data: ${JSON.stringify({ type: 'error', error: { message: event.error } })}\n\n`);
            break;
          }
          if (event.type === 'content_delta') {
            res.raw.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: event.delta })}\n\n`);
          } else if (event.type === 'done') {
            res.raw.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, status: 'completed' } })}\n\n`);
          }
        }

        res.raw.end();
      } else {
        const response = await this.gateway.createResponse(request);
        const formatted = this.compat.formatResponsesResponse(response);
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
