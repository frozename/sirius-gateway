import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization as string | undefined;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: {
          message: 'Invalid API key provided.',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    }

    const token = authorization.slice(7);
    const validKeys =
      this.configService
        .get<string>('SIRIUS_API_KEYS')
        ?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? [];

    if (validKeys.length === 0 || !validKeys.includes(token)) {
      throw new UnauthorizedException({
        error: {
          message: 'Invalid API key provided.',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    }

    request.apiKey = token;
    return true;
  }
}
