import { Injectable } from '@nestjs/common';
import { nova } from '@sirius/core';
import type {
  UnifiedAiRequest as SiriusReq,
  UnifiedAiResponse as SiriusRes,
  UnifiedStreamEvent as SiriusStreamEvent,
  UnifiedEmbeddingRequest as SiriusEmbReq,
  UnifiedEmbeddingResponse as SiriusEmbRes,
  ModelInfo as SiriusModelInfo,
  ProviderHealth as SiriusHealth,
  AiProvider,
} from '@sirius/core';

/**
 * Sirius adapter wrapping ONE llamactl agent node. An llamactl node's
 * `/v1` surface is OpenAI-compatible, so under the hood this delegates
 * to `nova.createOpenAICompatProvider` and translates nova's
 * wire-compat response shape into sirius's legacy `UnifiedAiResponse`
 * on the boundary — non-invasive, keeps the existing
 * `GatewayService` + controllers unchanged while sirius migrates
 * off its legacy types.
 *
 * One adapter per llamactl node; the module registers N instances
 * named `llamactl-<nodeName>` so each node shows up in sirius's
 * provider catalog independently.
 */
@Injectable()
export class LlamactlAdapter implements AiProvider {
  readonly name: string;
  private readonly nova: nova.AiProvider;

  constructor(opts: {
    nodeName: string;
    baseUrl: string;
    apiKey: string;
    displayName?: string;
  }) {
    this.name = `llamactl-${opts.nodeName}`;
    this.nova = nova.createOpenAICompatProvider({
      name: this.name,
      displayName: opts.displayName ?? `llamactl node ${opts.nodeName}`,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
    });
  }

  async createResponse(request: SiriusReq): Promise<SiriusRes> {
    const novaReq = siriusRequestToNova(request);
    const novaRes = await this.nova.createResponse(novaReq);
    return novaResponseToSirius(novaRes, this.name);
  }

  async *streamResponse(request: SiriusReq): AsyncIterable<SiriusStreamEvent> {
    const novaReq = siriusRequestToNova(request);
    const stream = this.nova.streamResponse?.(novaReq);
    if (!stream) {
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    for await (const ev of stream) {
      const translated = novaStreamEventToSirius(ev);
      if (translated) yield translated;
    }
  }

  async createEmbeddings(request: SiriusEmbReq): Promise<SiriusEmbRes> {
    if (!this.nova.createEmbeddings) {
      throw new Error(`${this.name}: embeddings not supported`);
    }
    const novaReq: nova.UnifiedEmbeddingRequest = {
      model: request.model,
      input: request.input,
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.user !== undefined ? { user: request.user } : {}),
    };
    const res = await this.nova.createEmbeddings(novaReq);
    const started = Date.now();
    const embeddings: number[][] = res.data.map((row) =>
      Array.isArray(row.embedding) ? (row.embedding as number[]) : [],
    );
    return {
      id: `emb-${started}`,
      model: res.model,
      provider: this.name,
      embeddings,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: 0,
        totalTokens: res.usage?.total_tokens ?? 0,
      },
      latencyMs: res.latencyMs ?? 0,
    };
  }

  async listModels(): Promise<SiriusModelInfo[]> {
    if (!this.nova.listModels) return [];
    const models = await this.nova.listModels();
    return models.map((m) => ({
      id: m.id,
      provider: this.name,
      ...(m.created !== undefined ? { created: m.created } : {}),
      ...(m.owned_by !== undefined ? { ownedBy: m.owned_by } : {}),
    }));
  }

  async healthCheck(): Promise<SiriusHealth> {
    if (!this.nova.healthCheck) {
      return {
        provider: this.name,
        status: 'healthy',
        lastChecked: new Date(),
      };
    }
    const h = await this.nova.healthCheck();
    return {
      provider: this.name,
      // sirius enum lacks `unknown`; treat it as degraded until we
      // know for sure. `unhealthy` maps to sirius's `down`.
      status:
        h.state === 'healthy'
          ? 'healthy'
          : h.state === 'degraded'
            ? 'degraded'
            : h.state === 'unhealthy'
              ? 'down'
              : 'degraded',
      ...(h.latencyMs != null ? { latencyMs: h.latencyMs } : {}),
      lastChecked: new Date(h.lastChecked),
      ...(h.error ? { error: h.error } : {}),
    };
  }
}

// ---- sirius ↔ nova translators ---------------------------------------

function siriusRequestToNova(req: SiriusReq): nova.UnifiedAiRequest {
  return {
    model: req.model,
    messages: req.messages.map((m) => ({
      role: (m.role === 'tool' ? 'tool' : m.role) as nova.Role,
      content: typeof m.content === 'string' ? m.content : translateContent(m.content),
      ...(m.name !== undefined ? { name: m.name } : {}),
      ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls
        ? {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: tc.function,
            })),
          }
        : {}),
    })),
    stream: req.stream,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.stop !== undefined ? { stop: req.stop } : {}),
    ...(req.user !== undefined ? { user: req.user } : {}),
  };
}

function translateContent(
  parts: Array<{ type: string; text?: string; imageUrl?: string; detail?: 'auto' | 'low' | 'high' }>,
): nova.ContentBlock[] {
  return parts.map((p) => {
    if (p.type === 'text') {
      return { type: 'text', text: p.text ?? '' };
    }
    // image_url — sirius uses flat, nova uses nested OpenAI shape.
    return {
      type: 'image_url',
      image_url: {
        url: p.imageUrl ?? '',
        ...(p.detail ? { detail: p.detail } : {}),
      },
    };
  });
}

function novaResponseToSirius(res: nova.UnifiedAiResponse, providerName: string): SiriusRes {
  const choice = res.choices[0];
  const content = typeof choice?.message.content === 'string' ? choice.message.content : '';
  return {
    id: res.id,
    model: res.model,
    provider: providerName,
    content: [{ type: 'text', text: content }],
    finishReason: (choice?.finish_reason ?? 'stop') as SiriusRes['finishReason'],
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
    },
    latencyMs: res.latencyMs ?? 0,
  };
}

function novaStreamEventToSirius(ev: nova.UnifiedStreamEvent): SiriusStreamEvent | null {
  if (ev.type === 'chunk') {
    const delta = ev.chunk.choices[0]?.delta.content;
    if (typeof delta === 'string' && delta.length > 0) {
      return { type: 'content_delta', delta };
    }
    return null;
  }
  if (ev.type === 'error') {
    const out: SiriusStreamEvent = {
      type: 'error',
      error: ev.error.message,
      ...(ev.error.code ? { code: ev.error.code } : {}),
    };
    return out;
  }
  if (ev.type === 'done') {
    return { type: 'done', finishReason: ev.finish_reason ?? 'stop' };
  }
  // tool_call — not yet surfaced in sirius's legacy stream enum.
  return null;
}
