import type { UnifiedMessage } from './unified-message.js';

export interface UnifiedTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type UnifiedToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface UnifiedResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface UnifiedAiRequest {
  requestId: string;
  model: string;
  messages: UnifiedMessage[];
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: UnifiedTool[];
  toolChoice?: UnifiedToolChoice;
  responseFormat?: UnifiedResponseFormat;
  streamOptions?: { includeUsage?: boolean };
  user?: string;
  metadata?: Record<string, string>;
}
