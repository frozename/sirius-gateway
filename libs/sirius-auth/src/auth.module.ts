import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { BearerAuthGuard } from './auth.guard';

@Global()
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: BearerAuthGuard,
    },
  ],
  exports: [],
})
export class AuthModule {}
