import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Gateway');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const start = Date.now();
    const requestId =
      request.id ?? request.headers?.['x-request-id'] ?? 'unknown';

    return next.handle().pipe(
      tap({
        next: (response: unknown) => {
          const latency = Date.now() - start;
          const meta = this.extractMeta(response);
          this.logger.log({
            requestId,
            method: request.method,
            path: request.url,
            statusCode: 200,
            latencyMs: latency,
            ...meta,
          });
        },
        error: (error: unknown) => {
          const latency = Date.now() - start;
          this.logger.error({
            requestId,
            method: request.method,
            path: request.url,
            latencyMs: latency,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      }),
    );
  }

  private extractMeta(response: unknown): Record<string, unknown> {
    if (
      response &&
      typeof response === 'object' &&
      '_gatewayMeta' in response
    ) {
      const meta = (response as Record<string, unknown>)
        ._gatewayMeta as Record<string, unknown>;
      return {
        provider: meta.provider,
        model: meta.model,
        strategy: meta.strategy,
        tokensUsed: meta.tokensUsed,
        providerLatencyMs: meta.providerLatencyMs,
        fallbackUsed: meta.fallbackUsed,
      };
    }
    return {};
  }
}
