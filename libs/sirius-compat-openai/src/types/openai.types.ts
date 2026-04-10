// ── Chat Completion Request ────────────────────────────────────────

export interface OpenAiChatCompletionRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  response_format?: OpenAiResponseFormat;
  n?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

// ── Messages ───────────────────────────────────────────────────────

export interface OpenAiSystemMessage {
  role: 'system';
  content: string;
  name?: string;
}

export interface OpenAiUserMessage {
  role: 'user';
  content: string | OpenAiContentPart[];
  name?: string;
}

export interface OpenAiAssistantMessage {
  role: 'assistant';
  content?: string | null;
  tool_calls?: OpenAiToolCallMsg[];
  name?: string;
}

export interface OpenAiToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export type OpenAiMessage =
  | OpenAiSystemMessage
  | OpenAiUserMessage
  | OpenAiAssistantMessage
  | OpenAiToolMessage;

// ── Content Parts ──────────────────────────────────────────────────

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

// ── Tools ──────────────────────────────────────────────────────────

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

// ── Response Format ────────────────────────────────────────────────

export type OpenAiResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
      };
    };

// ── Chat Completion Response ───────────────────────────────────────

export interface OpenAiChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAiChoice[];
  usage?: OpenAiUsage;
  system_fingerprint?: string;
}

export interface OpenAiChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAiToolCallMsg[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface OpenAiToolCallMsg {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── Streaming ──────────────────────────────────────────────────────

export interface OpenAiChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAiChunkChoice[];
  usage?: OpenAiUsage | null;
}

export interface OpenAiChunkChoice {
  index: number;
  delta: OpenAiChunkDelta;
  finish_reason: string | null;
}

export interface OpenAiChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

// ── Embeddings ─────────────────────────────────────────────────────

export interface OpenAiEmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
  dimensions?: number;
  user?: string;
}

export interface OpenAiEmbeddingResponse {
  object: 'list';
  data: { object: 'embedding'; index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ── Models ─────────────────────────────────────────────────────────

export interface OpenAiModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OpenAiModelList {
  object: 'list';
  data: OpenAiModel[];
}

// ── Responses API ──────────────────────────────────────────────────

export interface OpenAiResponsesRequest {
  model: string;
  input: string | OpenAiResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  user?: string;
  metadata?: Record<string, string>;
  previous_response_id?: string;
}

export type OpenAiResponsesInputItem =
  | {
      type: 'message';
      role: 'system' | 'developer' | 'user' | 'assistant';
      content: string | { type: string; text?: string }[];
    }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface OpenAiResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  output: OpenAiResponsesOutputItem[];
  status: 'completed' | 'failed' | 'incomplete';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export type OpenAiResponsesOutputItem =
  | {
      type: 'message';
      id: string;
      role: 'assistant';
      status: string;
      content: { type: 'output_text'; text: string }[];
    }
  | {
      type: 'function_call';
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: string;
    };

// ── Errors ─────────────────────────────────────────────────────────

export interface OpenAiErrorResponse {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
