import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';

export function createLoggerConfig(): Params {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    pinoHttp: {
      level:
        process.env.SIRIUS_LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

      genReqId: (req: IncomingMessage) => {
        const existing = req.headers['x-request-id'];
        return (
          (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID()
        );
      },

      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
        censor: '**REDACTED**',
      },

      serializers: {
        req(req: Record<string, unknown>) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res: Record<string, unknown>) {
          return { statusCode: res.statusCode };
        },
      },

      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/health',
      },

      transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
    },

    forRoutes: [{ path: '*path', method: RequestMethod.ALL }],
    exclude: [{ method: RequestMethod.ALL, path: 'health' }],
  };
}
