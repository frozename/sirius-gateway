import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class GatewayExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GatewayExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Check if the exception already has OpenAI-format error body
    if (exception instanceof HttpException) {
      const exResponse = exception.getResponse();
      if (
        typeof exResponse === 'object' &&
        exResponse !== null &&
        'error' in exResponse
      ) {
        reply.status(status).send(exResponse);
        return;
      }
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const message =
      exception instanceof HttpException
        ? exception.message
        : 'Internal server error';

    const ERROR_TYPE_MAP: Record<number, string> = {
      400: 'invalid_request_error',
      401: 'authentication_error',
      403: 'permission_error',
      404: 'not_found_error',
      429: 'rate_limit_error',
      500: 'server_error',
    };

    reply.status(status).send({
      error: {
        message,
        type: ERROR_TYPE_MAP[status] ?? 'api_error',
        param: null,
        code: null,
      },
    });
  }
}
