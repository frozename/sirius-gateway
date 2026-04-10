/** OpenAI-specific request / response types (subset needed for the gateway). */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAiContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

export interface OpenAiContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type OpenAiToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAiResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  response_format?: OpenAiResponseFormat;
  stream_options?: { include_usage?: boolean };
  user?: string;
}

export interface OpenAiChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAiChoice[];
  usage: OpenAiUsage;
}

export interface OpenAiChoice {
  index: number;
  message: OpenAiMessage;
  finish_reason: string | null;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAiChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage | null;
}

/** In streaming chunks, tool_calls deltas carry an index field not present in the non-streaming type. */
export interface OpenAiChunkToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAiChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAiChunkToolCallDelta[];
}

export interface OpenAiChunkChoice {
  index: number;
  delta: OpenAiChunkDelta;
  finish_reason: string | null;
}

// ── Embeddings ──────────────────────────────────────────────────────

export interface OpenAiEmbeddingRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  user?: string;
}

export interface OpenAiEmbeddingResponse {
  object: string;
  data: OpenAiEmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface OpenAiEmbeddingData {
  object: string;
  index: number;
  embedding: number[];
}

// ── Models ──────────────────────────────────────────────────────────

export interface OpenAiModelList {
  object: string;
  data: OpenAiModel[];
}

export interface OpenAiModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}
