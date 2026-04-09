import { expect, test, describe, beforeEach, spyOn } from 'bun:test';
import { ObservabilityInterceptor } from '../observability.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

describe('ObservabilityInterceptor', () => {
  let interceptor: ObservabilityInterceptor;
  let loggerLogSpy: any;
  let loggerErrorSpy: any;
  
  beforeEach(() => {
    interceptor = new ObservabilityInterceptor();
    loggerLogSpy = spyOn(interceptor['logger'], 'log').mockImplementation(() => {});
    loggerErrorSpy = spyOn(interceptor['logger'], 'error').mockImplementation(() => {});
  });

  const createMockContext = (request: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  const createMockCallHandler = (value: any, isError = false): CallHandler => {
    return {
      handle: () => (isError ? throwError(() => value) : of(value)),
    };
  };

  test('logs success with method/path/statusCode/latencyMs', async () => {
    const context = createMockContext({
      method: 'GET',
      url: '/test',
      id: 'req-1',
    });
    const handler = createMockCallHandler({ data: 'ok' });

    const observable = interceptor.intercept(context, handler);
    
    await new Promise<void>((resolve) => {
      observable.subscribe({
        complete: () => resolve(),
      });
    });

    expect(loggerLogSpy).toHaveBeenCalled();
    const logArgs = loggerLogSpy.mock.calls[0][0];
    expect(logArgs.method).toBe('GET');
    expect(logArgs.path).toBe('/test');
    expect(logArgs.statusCode).toBe(200);
    expect(logArgs.latencyMs).toBeGreaterThanOrEqual(0);
    expect(logArgs.requestId).toBe('req-1');
  });

  test('logs error with message', async () => {
    const context = createMockContext({
      method: 'POST',
      url: '/fail',
      id: 'req-2',
    });
    const error = new Error('Test error');
    const handler = createMockCallHandler(error, true);

    const observable = interceptor.intercept(context, handler);
    
    await new Promise<void>((resolve) => {
      observable.subscribe({
        error: () => resolve(),
      });
    });

    expect(loggerErrorSpy).toHaveBeenCalled();
    const logArgs = loggerErrorSpy.mock.calls[0][0];
    expect(logArgs.method).toBe('POST');
    expect(logArgs.path).toBe('/fail');
    expect(logArgs.error).toBe('Test error');
    expect(logArgs.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('extracts _gatewayMeta fields', async () => {
    const context = createMockContext({ method: 'POST', url: '/chat', id: '1' });
    const responseWithMeta = {
      choices: [],
      _gatewayMeta: {
        provider: 'openai',
        model: 'gpt-4',
        strategy: 'fastest',
        tokensUsed: { total: 10 },
        providerLatencyMs: 150,
        fallbackUsed: false,
      },
    };
    const handler = createMockCallHandler(responseWithMeta);

    const observable = interceptor.intercept(context, handler);
    await new Promise<void>((resolve) => {
      observable.subscribe({ complete: () => resolve() });
    });

    const logArgs = loggerLogSpy.mock.calls[0][0];
    expect(logArgs.provider).toBe('openai');
    expect(logArgs.model).toBe('gpt-4');
    expect(logArgs.strategy).toBe('fastest');
    expect(logArgs.tokensUsed).toEqual({ total: 10 });
    expect(logArgs.providerLatencyMs).toBe(150);
    expect(logArgs.fallbackUsed).toBe(false);
  });

  test('handles response without _gatewayMeta', async () => {
    const context = createMockContext({ method: 'GET', url: '/health', id: '1' });
    const handler = createMockCallHandler({ status: 'ok' });

    const observable = interceptor.intercept(context, handler);
    await new Promise<void>((resolve) => {
      observable.subscribe({ complete: () => resolve() });
    });

    const logArgs = loggerLogSpy.mock.calls[0][0];
    expect(logArgs.provider).toBeUndefined();
    expect(logArgs.model).toBeUndefined();
  });

  test('reads requestId from request.id', async () => {
    const context = createMockContext({ id: 'explicit-id', headers: { 'x-request-id': 'header-id' } });
    const handler = createMockCallHandler({});

    const observable = interceptor.intercept(context, handler);
    await new Promise<void>((resolve) => observable.subscribe({ complete: () => resolve() }));

    expect(loggerLogSpy.mock.calls[0][0].requestId).toBe('explicit-id');
  });

  test('falls back to x-request-id header', async () => {
    const context = createMockContext({ headers: { 'x-request-id': 'header-id' } });
    const handler = createMockCallHandler({});

    const observable = interceptor.intercept(context, handler);
    await new Promise<void>((resolve) => observable.subscribe({ complete: () => resolve() }));

    expect(loggerLogSpy.mock.calls[0][0].requestId).toBe('header-id');
  });

  test('falls back to unknown', async () => {
    const context = createMockContext({});
    const handler = createMockCallHandler({});

    const observable = interceptor.intercept(context, handler);
    await new Promise<void>((resolve) => observable.subscribe({ complete: () => resolve() }));

    expect(loggerLogSpy.mock.calls[0][0].requestId).toBe('unknown');
  });
});
