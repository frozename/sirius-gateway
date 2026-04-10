import { Logger } from '@nestjs/common';
import type { UnifiedStreamEvent } from '@sirius/core';

export class StreamingObserver {
  private readonly logger = new Logger('StreamingObserver');

  observe<T extends UnifiedStreamEvent>(
    stream: AsyncIterable<T>,
    metadata: {
      requestId: string;
      model: string;
      provider: string;
    },
  ): AsyncIterable<T> {
    const self = this;
    const start = Date.now();
    let chunkCount = 0;
    let totalBytes = 0;
    let tokenUsage: any = null;

    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const event of stream) {
            chunkCount++;
            
            if (event.type === 'content_delta') {
              totalBytes += Buffer.byteLength(event.delta, 'utf8');
            } else if (event.type === 'usage') {
              tokenUsage = event.usage;
            }

            yield event;
          }
        } finally {
          const durationMs = Date.now() - start;
          self.logger.log({
            message: 'Stream completed',
            requestId: metadata.requestId,
            model: metadata.model,
            provider: metadata.provider,
            durationMs,
            chunkCount,
            totalBytes,
            tokenUsage,
          });
        }
      },
    };
  }
}
