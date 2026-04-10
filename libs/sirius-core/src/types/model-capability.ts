export interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  embeddings: boolean;
  vision: boolean;
  jsonMode: boolean;
}

export interface ModelCapabilityMatrix {
  modelId: string;
  provider: string;
  displayName?: string;
  aliases: string[];
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}
