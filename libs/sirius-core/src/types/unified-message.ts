export type UnifiedRole = 'system' | 'user' | 'assistant' | 'tool';

export interface UnifiedContentPart {
  type: 'text' | 'image_url';
  text?: string;
  imageUrl?: string;
  detail?: 'auto' | 'low' | 'high';
}

export interface UnifiedMessage {
  role: UnifiedRole;
  content: string | UnifiedContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: UnifiedToolCall[];
}

export interface UnifiedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
