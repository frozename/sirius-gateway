import { describe, it, expect } from 'bun:test';
import { BearerAuthGuard } from '../auth.guard';
import { UnauthorizedException } from '@nestjs/common';

// Minimal mocks for NestJS dependencies
function createMockGuard(apiKeys: string) {
  const configService = {
    get: (key: string) => {
      if (key === 'SIRIUS_API_KEYS') return apiKeys;
      return undefined;
    },
  };

  const reflector = {
    getAllAndOverride: () => false,
  };

  return new BearerAuthGuard(configService as any, reflector as any);
}

function createMockContext(headers: Record<string, string> = {}, isPublic = false) {
  const request = { headers, apiKey: undefined as string | undefined };

  const reflector = {
    getAllAndOverride: () => isPublic,
  };

  return {
    context: {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any,
    request,
    reflector,
  };
}

describe('BearerAuthGuard', () => {
  it('allows valid bearer token', () => {
    const guard = createMockGuard('sk-test-key,sk-other-key');
    const { context, request } = createMockContext({
      authorization: 'Bearer sk-test-key',
    });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.apiKey).toBe('sk-test-key');
  });

  it('allows second key in comma-separated list', () => {
    const guard = createMockGuard('sk-first,sk-second');
    const { context, request } = createMockContext({
      authorization: 'Bearer sk-second',
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.apiKey).toBe('sk-second');
  });

  it('rejects missing authorization header', () => {
    const guard = createMockGuard('sk-test-key');
    const { context } = createMockContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects non-bearer authorization', () => {
    const guard = createMockGuard('sk-test-key');
    const { context } = createMockContext({
      authorization: 'Basic dXNlcjpwYXNz',
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects invalid token', () => {
    const guard = createMockGuard('sk-test-key');
    const { context } = createMockContext({
      authorization: 'Bearer wrong-key',
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('returns OpenAI-format error on rejection', () => {
    const guard = createMockGuard('sk-test-key');
    const { context } = createMockContext({});

    try {
      guard.canActivate(context);
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      const response = (e as UnauthorizedException).getResponse() as any;
      expect(response.error.type).toBe('authentication_error');
      expect(response.error.code).toBe('invalid_api_key');
    }
  });

  it('allows public routes regardless of auth', () => {
    const configService = {
      get: () => 'sk-test-key',
    };
    const reflector = {
      getAllAndOverride: () => true, // isPublic = true
    };
    const guard = new BearerAuthGuard(configService as any, reflector as any);

    const context = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
  });
});
