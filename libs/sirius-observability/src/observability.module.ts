import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ObservabilityInterceptor } from './observability.interceptor';
import { StreamingObserver } from './streaming-observer';
import { LatencyTracker } from './latency-tracker.service';
import { UsageRecorderService } from './usage-recorder.service';

@Module({
  providers: [
    ObservabilityInterceptor,
    StreamingObserver,
    LatencyTracker,
    UsageRecorderService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ObservabilityInterceptor,
    },
  ],
  exports: [
    ObservabilityInterceptor,
    StreamingObserver,
    LatencyTracker,
    UsageRecorderService,
  ],
})
export class ObservabilityModule {}
