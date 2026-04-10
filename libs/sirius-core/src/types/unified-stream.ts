import type { UsageMetrics } from './unified-response.js';

export type UnifiedStreamEvent =
  | { type: 'content_delta'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: UsageMetrics }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: string; code?: string };
