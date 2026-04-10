import type { UnifiedToolCall } from './unified-message.js';

export type UnifiedFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error';

export interface UnifiedContent {
  type: 'text' | 'tool_call';
  text?: string;
  toolCall?: UnifiedToolCall;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UnifiedAiResponse {
  id: string;
  model: string;
  provider: string;
  content: UnifiedContent[];
  finishReason: UnifiedFinishReason;
  usage: UsageMetrics;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}
