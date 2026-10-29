import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RequestMethod } from '@nestjs/common';
import pino from 'pino';
import { createLoggerConfig } from '../logging.config';

/**
 * Pins createLoggerConfig: log level resolution, request-id
 * propagation, header redaction, the req/res serializers, the
 * /health auto-logging skip, the dev transport and the route lists.
 * createLoggerConfig reads process.env at call time, so each case
 * sets NODE_ENV / SIRIUS_LOG_LEVEL first and afterEach restores them.
 */

type HttpLoggerOptions = {
  level: string;
  genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => unknown;
  redact: { paths: string[]; censor: string };
  serializers: {
    req: (req: Record<string, unknown>) => Record<string, unknown>;
    res: (res: Record<string, unknown>) => Record<string, unknown>;
  };
  autoLogging: { ignore: (req: { url: string }) => boolean };
  transport: unknown;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function httpOptions(): HttpLoggerOptions {
  return createLoggerConfig().pinoHttp as unknown as HttpLoggerOptions;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

let savedNodeEnv: string | undefined;
let savedLogLevel: string | undefined;

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  savedLogLevel = process.env.SIRIUS_LOG_LEVEL;
  Reflect.deleteProperty(process.env, 'NODE_ENV');
  Reflect.deleteProperty(process.env, 'SIRIUS_LOG_LEVEL');
});
afterEach(() => {
  restoreEnv('NODE_ENV', savedNodeEnv);
  restoreEnv('SIRIUS_LOG_LEVEL', savedLogLevel);
});

describe('createLoggerConfig level', () => {
  test('defaults to debug when NODE_ENV is unset', () => {
    expect(httpOptions().level).toBe('debug');
  });

  test('defaults to debug for a non-production NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    expect(httpOptions().level).toBe('debug');
  });

  test('defaults to info when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(httpOptions().level).toBe('info');
  });

  test('SIRIUS_LOG_LEVEL wins outside production', () => {
    process.env.SIRIUS_LOG_LEVEL = 'warn';
    expect(httpOptions().level).toBe('warn');
  });

  test('SIRIUS_LOG_LEVEL wins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SIRIUS_LOG_LEVEL = 'error';
    expect(httpOptions().level).toBe('error');
  });
});

describe('createLoggerConfig genReqId', () => {
  test('returns a string x-request-id header verbatim', () => {
    expect(httpOptions().genReqId({ headers: { 'x-request-id': 'req-7731' } })).toBe('req-7731');
  });

  test('returns the first value of an array x-request-id header', () => {
    const headers = { 'x-request-id': ['first-7731', 'second-7731'] };
    expect(httpOptions().genReqId({ headers })).toBe('first-7731');
  });

  test('an empty x-request-id array falls back to a fresh UUID', () => {
    const id = httpOptions().genReqId({ headers: { 'x-request-id': [] } });
    expect(typeof id).toBe('string');
    expect(String(id)).toMatch(UUID_V4);
  });

  test('a missing x-request-id header yields a fresh UUID per call', () => {
    const genReqId = httpOptions().genReqId;
    const first = genReqId({ headers: {} });
    const second = genReqId({ headers: {} });
    expect(String(first)).toMatch(UUID_V4);
    expect(String(second)).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });
});

describe('createLoggerConfig redaction and serializers', () => {
  test('redacts the authorization and x-api-key request headers', () => {
    expect(httpOptions().redact).toEqual({
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      censor: '**REDACTED**',
    });
  });

  test('pino applies the redact options to both header paths', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: httpOptions().redact },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    );
    const headers = { authorization: 'mk-7731', 'x-api-key': 'mk-7732', accept: 'text/plain' };
    logger.info({ req: { headers } }, 'probe');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '') as { req: { headers: Record<string, string> } };
    expect(record.req.headers).toEqual({
      authorization: '**REDACTED**',
      'x-api-key': '**REDACTED**',
      accept: 'text/plain',
    });
    expect(lines[0]).not.toContain('mk-773');
  });

  test('the req serializer keeps only id, method and url', () => {
    const out = httpOptions().serializers.req({
      id: 'req-7731',
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'mk-7731' },
      body: { model: 'm-1' },
    });
    expect(out).toStrictEqual({ id: 'req-7731', method: 'POST', url: '/v1/chat/completions' });
    expect(JSON.stringify(out)).not.toContain('mk-7731');
  });

  test('the res serializer keeps only statusCode', () => {
    const out = httpOptions().serializers.res({ statusCode: 201, headers: { 'x-a': 'b' } });
    expect(out).toStrictEqual({ statusCode: 201 });
  });
});

describe('createLoggerConfig routing and transport', () => {
  test('auto-logging skips exactly /health', () => {
    const ignore = httpOptions().autoLogging.ignore;
    expect(ignore({ url: '/health' })).toBe(true);
    expect(ignore({ url: '/health/all' })).toBe(false);
    expect(ignore({ url: '/health?probe=1' })).toBe(false);
    expect(ignore({ url: '/v1/chat/completions' })).toBe(false);
  });

  test('uses pino-pretty with colors outside production', () => {
    expect(httpOptions().transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true },
    });
  });

  test('has no transport in production', () => {
    process.env.NODE_ENV = 'production';
    expect(httpOptions().transport).toBeUndefined();
  });

  test('applies to every route except health', () => {
    const config = createLoggerConfig();
    expect(config.forRoutes).toEqual([{ path: '*path', method: RequestMethod.ALL }]);
    expect(config.exclude).toEqual([{ method: RequestMethod.ALL, path: 'health' }]);
  });
});
