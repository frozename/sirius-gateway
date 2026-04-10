import { Body, Controller, HttpCode, Post, Req, Res, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAiEmbeddingRequest } from '@sirius/compat-openai';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { GatewayService } from '../gateway.service';

@Controller('v1')
export class EmbeddingsController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly compat: OpenAiCompatService,
  ) {}

  @Post('embeddings')
  @HttpCode(200)
  async createEmbeddings(
    @Body() body: OpenAiEmbeddingRequest,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const requestId = (req.id as string) ?? randomUUID();

    try {
      const request = this.compat.parseEmbeddingRequest(body, requestId);
      const response = await this.gateway.createEmbeddings(request);
      const formatted = this.compat.formatEmbeddingResponse(response);
      res.header('X-Request-Id', requestId);
      return res.send(formatted);
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
