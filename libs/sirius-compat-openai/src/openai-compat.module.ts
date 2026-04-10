import { Module } from '@nestjs/common';
import { OpenAiCompatService } from './openai-compat.service';

@Module({
  providers: [OpenAiCompatService],
  exports: [OpenAiCompatService],
})
export class OpenAiCompatModule {}
