import { Body, Controller, HttpCode, Post, Req, Res, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAiEmbeddingRequest } from '@sirius/compat-openai';
import { OpenAiCompatService } from '@sirius/compat-openai';
import { UsageRecorderService } from '@sirius/observability';
import { GatewayService } from '../gateway.service';

@Controller('v1')
export class EmbeddingsController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly compat: OpenAiCompatService,
    private readonly usageRecorder: UsageRecorderService,
  ) {}

  @Post('embeddings')
  @HttpCode(200)
  async createEmbeddings(
    @Body() body: OpenAiEmbeddingRequest,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const requestId = (req.id as string) ?? randomUUID();
    // A client that drops the connection before the response
    // completes aborts the upstream call instead of leaving it
    // running.
    const abort = new AbortController();
    res.raw.on('close', () => abort.abort());

    try {
      const request = this.compat.parseEmbeddingRequest(body, requestId);
      const response = await this.gateway.createEmbeddings(request, {
        signal: abort.signal,
      });
      const formatted = this.compat.formatEmbeddingResponse(response);
      this.usageRecorder.record({
        provider: response.provider,
        model: response.model,
        kind: 'embedding',
        promptTokens: response.usage.inputTokens,
        completionTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        latencyMs: response.latencyMs,
        requestId,
        observation: response.metadata?.usageObservation,
      });
      res.header('X-Request-Id', requestId);
      return res.send(formatted);
    } catch (error) {
      if (res.raw.destroyed) {
        return res;
      }
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
