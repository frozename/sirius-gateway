import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type {
  ModelInfo,
  UnifiedAiRequest,
  UnifiedAiResponse,
  UnifiedContent,
  UnifiedEmbeddingRequest,
  UnifiedEmbeddingResponse,
  UnifiedMessage,
  UnifiedResponseFormat,
  UnifiedStreamEvent,
  UnifiedToolChoice,
} from '@sirius/core';

import type {
  OpenAiChatCompletion,
  OpenAiChatCompletionChunk,
  OpenAiChatCompletionRequest,
  OpenAiChunkChoice,
  OpenAiEmbeddingRequest,
  OpenAiEmbeddingResponse,
  OpenAiErrorResponse,
  OpenAiMessage,
  OpenAiModelList,
  OpenAiResponsesInputItem,
  OpenAiResponsesOutputItem,
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
  OpenAiToolCallMsg,
  OpenAiUsage,
} from './types/index';

// ── Finish-reason mapping ──────────────────────────────────────────

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  error: 'error',
};

function toOpenAiFinishReason(reason: string): string {
  return FINISH_REASON_MAP[reason] ?? 'stop';
}

@Injectable()
export class OpenAiCompatService {
  // ── Request Converters ─────────────────────────────────────────

  parseChatCompletionRequest(
    body: OpenAiChatCompletionRequest,
    requestId: string,
  ): UnifiedAiRequest {
    if (!body.model) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'model' field is required.",
        'invalid_request_error',
        'model_required',
      );
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'messages' field is required and must be a non-empty array.",
        'invalid_request_error',
        'messages_required',
      );
    }

    if (body.temperature !== undefined && (body.temperature < 0 || body.temperature > 2)) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'temperature' must be between 0 and 2.",
        'invalid_request_error',
        'invalid_temperature',
      );
    }

    if (body.top_p !== undefined && (body.top_p < 0 || body.top_p > 1)) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'top_p' must be between 0 and 1.",
        'invalid_request_error',
        'invalid_top_p',
      );
    }

    if (body.n !== undefined && body.n > 1) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        'Multiple completions (n > 1) are not supported by this gateway.',
        'invalid_request_error',
        'unsupported_parameter',
      );
    }

    const messages = body.messages.map((msg, index) => {
      if (!msg.role) {
        throw this.createHttpError(
          HttpStatus.BAD_REQUEST,
          `Message at index ${index} is missing 'role'.`,
          'invalid_request_error',
        );
      }
      if (msg.role !== 'assistant' && msg.content === undefined) {
        throw this.createHttpError(
          HttpStatus.BAD_REQUEST,
          `Message at index ${index} is missing 'content'.`,
          'invalid_request_error',
        );
      }
      return this.mapOpenAiMessage(msg);
    });

    const request: UnifiedAiRequest = {
      requestId,
      model: body.model,
      messages,
      stream: body.stream ?? false,
    };

    if ((body as any).stream_options) {
      request.streamOptions = {
        includeUsage: (body as any).stream_options.include_usage,
      };
    }

    if (body.temperature !== undefined) request.temperature = body.temperature;
    if (body.top_p !== undefined) request.topP = body.top_p;

    const maxTokens = body.max_completion_tokens ?? body.max_tokens;
    if (maxTokens !== undefined) request.maxTokens = maxTokens;

    if (body.stop !== undefined) {
      request.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
    }

    if (body.user) request.user = body.user;

    if (body.tools?.length) {
      request.tools = body.tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
          strict: t.function.strict,
        },
      }));
    }

    if (body.tool_choice !== undefined) {
      request.toolChoice = body.tool_choice as UnifiedToolChoice;
    }

    if (body.response_format) {
      request.responseFormat = this.mapResponseFormat(body.response_format);
    }

    return request;
  }

  parseEmbeddingRequest(
    body: OpenAiEmbeddingRequest,
    requestId: string,
  ): UnifiedEmbeddingRequest {
    if (!body.model) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'model' field is required.",
        'invalid_request_error',
        'model_required',
      );
    }
    if (!body.input) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'input' field is required.",
        'invalid_request_error',
        'input_required',
      );
    }

    const request: UnifiedEmbeddingRequest = {
      requestId,
      model: body.model,
      input: body.input,
    };

    if (body.dimensions !== undefined) request.dimensions = body.dimensions;
    if (body.user) request.user = body.user;

    return request;
  }

  parseResponsesRequest(
    body: OpenAiResponsesRequest,
    requestId: string,
  ): UnifiedAiRequest {
    if (!body.model) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'model' field is required.",
        'invalid_request_error',
        'model_required',
      );
    }
    if (!body.input) {
      throw this.createHttpError(
        HttpStatus.BAD_REQUEST,
        "The 'input' field is required.",
        'invalid_request_error',
        'input_required',
      );
    }

    const messages: UnifiedMessage[] = [];

    // Prepend instructions as a system message
    if (body.instructions) {
      messages.push({ role: 'system', content: body.instructions });
    }

    if (typeof body.input === 'string') {
      messages.push({ role: 'user', content: body.input });
    } else {
      for (const item of body.input) {
        messages.push(this.mapResponsesInputItem(item));
      }
    }

    const request: UnifiedAiRequest = {
      requestId,
      model: body.model,
      messages,
      stream: body.stream ?? false,
    };

    if ((body as any).stream_options) {
      request.streamOptions = {
        includeUsage: (body as any).stream_options.include_usage,
      };
    }

    if (body.temperature !== undefined) request.temperature = body.temperature;
    if (body.top_p !== undefined) request.topP = body.top_p;
    if (body.max_output_tokens !== undefined)
      request.maxTokens = body.max_output_tokens;
    if (body.user) request.user = body.user;
    if (body.metadata) request.metadata = body.metadata;

    if (body.tools?.length) {
      request.tools = body.tools.map((t) => ({
        type: t.type,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
          strict: t.function.strict,
        },
      }));
    }

    if (body.tool_choice !== undefined) {
      request.toolChoice = body.tool_choice as UnifiedToolChoice;
    }

    return request;
  }

  // ── Response Converters ────────────────────────────────────────

  formatChatCompletionResponse(
    response: UnifiedAiResponse,
  ): OpenAiChatCompletion {
    let textContent: string | null = null;
    const toolCalls: OpenAiToolCallMsg[] = [];

    for (const item of response.content) {
      if (item.type === 'text' && item.text) {
        textContent = textContent ? textContent + item.text : item.text;
      } else if (item.type === 'tool_call' && item.toolCall) {
        toolCalls.push({
          id: item.toolCall.id,
          type: 'function',
          function: {
            name: item.toolCall.function.name,
            arguments: item.toolCall.function.arguments,
          },
        });
      }
    }

    const message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAiToolCallMsg[];
    } = {
      role: 'assistant',
      content: textContent,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toOpenAiFinishReason(response.finishReason) as any,
        },
      ],
      usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
      },
    };
  }

  formatFirstStreamChunk(
    responseId: string,
    model: string,
  ): OpenAiChatCompletionChunk {
    return {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null,
        },
      ],
    };
  }

  formatStreamChunk(
    event: UnifiedStreamEvent,
    responseId: string,
    model: string,
  ): OpenAiChatCompletionChunk | null {
    const base = {
      id: responseId,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model,
    };

    switch (event.type) {
      case 'content_delta': {
        return {
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: event.delta },
              finish_reason: null,
            },
          ],
        };
      }

      case 'tool_call_delta': {
        const toolCallDelta: OpenAiChunkChoice['delta']['tool_calls'] = [
          {
            index: event.index,
            ...(event.id ? { id: event.id } : {}),
            ...(event.name || event.id ? { type: 'function' } : {}),
            function: {
              ...(event.name ? { name: event.name } : {}),
              ...(event.argumentsDelta
                ? { arguments: event.argumentsDelta }
                : {}),
            },
          },
        ];

        return {
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: toolCallDelta },
              finish_reason: null,
            },
          ],
        };
      }

      case 'done': {
        return {
          ...base,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: toOpenAiFinishReason(event.finishReason),
            },
          ],
        };
      }

      case 'usage': {
        return {
          ...base,
          choices: [],
          usage: {
            prompt_tokens: event.usage.inputTokens,
            completion_tokens: event.usage.outputTokens,
            total_tokens: event.usage.totalTokens,
          },
        };
      }

      case 'error': {
        // Errors are handled separately by the caller
        return null;
      }

      default:
        return null;
    }
  }

  formatEmbeddingResponse(
    response: UnifiedEmbeddingResponse,
  ): OpenAiEmbeddingResponse {
    return {
      object: 'list',
      data: response.embeddings.map((embedding, index) => ({
        object: 'embedding' as const,
        index,
        embedding,
      })),
      model: response.model,
      usage: {
        prompt_tokens: response.usage.inputTokens,
        total_tokens: response.usage.totalTokens,
      },
    };
  }

  formatResponsesResponse(
    response: UnifiedAiResponse,
  ): OpenAiResponsesResponse {
    const output: OpenAiResponsesOutputItem[] = [];
    const textParts: { type: 'output_text'; text: string }[] = [];

    for (const item of response.content) {
      if (item.type === 'text' && item.text) {
        textParts.push({ type: 'output_text', text: item.text });
      } else if (item.type === 'tool_call' && item.toolCall) {
        output.push({
          type: 'function_call',
          id: `fc_${randomUUID()}`,
          call_id: item.toolCall.id,
          name: item.toolCall.function.name,
          arguments: item.toolCall.function.arguments,
          status: 'completed',
        });
      }
    }

    if (textParts.length > 0) {
      output.unshift({
        type: 'message',
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        status: 'completed',
        content: textParts,
      });
    }

    const status =
      response.finishReason === 'error'
        ? 'failed'
        : response.finishReason === 'length'
          ? 'incomplete'
          : 'completed';

    const result: OpenAiResponsesResponse = {
      id: `resp_${randomUUID()}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: response.model,
      output,
      status,
    };

    if (response.usage) {
      result.usage = {
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        total_tokens: response.usage.totalTokens,
      };
    }

    return result;
  }

  formatModelList(models: ModelInfo[]): OpenAiModelList {
    const now = Math.floor(Date.now() / 1000);

    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: m.created ?? now,
        owned_by: m.ownedBy ?? m.provider,
      })),
    };
  }

  formatError(
    status: number,
    message: string,
    type?: string,
    code?: string,
  ): OpenAiErrorResponse {
    const ERROR_TYPE_MAP: Record<number, string> = {
      400: 'invalid_request_error',
      401: 'authentication_error',
      403: 'permission_error',
      404: 'not_found_error',
      429: 'rate_limit_error',
      500: 'server_error',
      503: 'service_unavailable_error',
    };

    return {
      error: {
        message,
        type: type ?? ERROR_TYPE_MAP[status] ?? 'api_error',
        param: null,
        code: code ?? null,
      },
    };
  }

  createHttpError(
    status: number,
    message: string,
    type?: string,
    code?: string,
  ): HttpException {
    return new HttpException(
      this.formatError(status, message, type, code),
      status,
    );
  }

  // ── SSE Helpers ────────────────────────────────────────────────

  formatSSE(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  formatSSEDone(): string {
    return 'data: [DONE]\n\n';
  }

  // ── Private helpers ────────────────────────────────────────────

  private mapOpenAiMessage(msg: OpenAiMessage): UnifiedMessage {
    switch (msg.role) {
      case 'system': {
        const unified: UnifiedMessage = {
          role: 'system',
          content: msg.content,
        };
        if (msg.name) unified.name = msg.name;
        return unified;
      }

      case 'user': {
        let content: UnifiedMessage['content'];

        if (typeof msg.content === 'string') {
          content = msg.content;
        } else {
          content = msg.content.map((part) => {
            if (part.type === 'image_url') {
              return {
                type: 'image_url' as const,
                imageUrl: part.image_url.url,
                detail: part.image_url.detail as any,
              };
            }
            return { type: 'text' as const, text: part.text };
          });
        }

        const unified: UnifiedMessage = { role: 'user', content };
        if (msg.name) unified.name = msg.name;
        return unified;
      }

      case 'assistant': {
        const unified: UnifiedMessage = {
          role: 'assistant',
          content: msg.content ?? '',
        };
        if (msg.name) unified.name = msg.name;
        if (msg.tool_calls?.length) {
          unified.toolCalls = msg.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        }
        return unified;
      }

      case 'tool': {
        return {
          role: 'tool',
          content: msg.content,
          toolCallId: msg.tool_call_id,
        };
      }

      default:
        return { role: 'user', content: '' };
    }
  }

  private mapResponsesInputItem(
    item: OpenAiResponsesInputItem,
  ): UnifiedMessage {
    if (item.type === 'function_call_output') {
      return {
        role: 'tool',
        content: item.output,
        toolCallId: item.call_id,
      };
    }

    // Map 'developer' to 'system' for unified format
    const role =
      item.role === 'developer'
        ? ('system' as const)
        : (item.role as 'system' | 'user' | 'assistant');

    let content: string;
    if (typeof item.content === 'string') {
      content = item.content;
    } else {
      content = item.content
        .filter((p) => p.text)
        .map((p) => p.text!)
        .join('');
    }

    return { role, content };
  }

  private mapResponseFormat(
    format: NonNullable<OpenAiChatCompletionRequest['response_format']>,
  ): UnifiedResponseFormat {
    if (format.type === 'json_schema' && 'json_schema' in format) {
      return {
        type: 'json_schema',
        jsonSchema: {
          name: format.json_schema.name,
          schema: format.json_schema.schema,
          strict: format.json_schema.strict,
        },
      };
    }

    return { type: format.type };
  }
}
