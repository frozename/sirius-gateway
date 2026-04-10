/** Ollama-specific request / response types. */

export interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: OllamaOptions;
  tools?: OllamaTool[];
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Stream chunks have the same shape; intermediate have done=false, final has done=true with counts.
export type OllamaChatChunk = OllamaChatResponse;

// ── Embeddings ──────────────────────────────────────────────────────

export interface OllamaEmbedRequest {
  model: string;
  input: string | string[];
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  prompt_eval_count?: number;
}

// ── Models ──────────────────────────────────────────────────────────

export interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}

export interface OllamaModelInfo {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
}
