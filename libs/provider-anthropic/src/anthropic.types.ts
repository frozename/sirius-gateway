/** Anthropic-specific request / response types (subset needed for the gateway). */

// ── Messages ────────────────────────────────────────────────────────

export type AnthropicRole = 'user' | 'assistant';

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

// ── Request ─────────────────────────────────────────────────────────

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
}

// ── Response ────────────────────────────────────────────────────────

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

// ── Streaming events ────────────────────────────────────────────────

export interface AnthropicStreamMessageStart {
  type: 'message_start';
  message: AnthropicResponse;
}

export interface AnthropicStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthropicStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string };
}

export interface AnthropicStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface AnthropicStreamMessageDelta {
  type: 'message_delta';
  delta: { stop_reason: string };
  usage: { output_tokens: number };
}

export interface AnthropicStreamMessageStop {
  type: 'message_stop';
}

export type AnthropicStreamEvent =
  | AnthropicStreamMessageStart
  | AnthropicStreamContentBlockStart
  | AnthropicStreamContentBlockDelta
  | AnthropicStreamContentBlockStop
  | AnthropicStreamMessageDelta
  | AnthropicStreamMessageStop;
