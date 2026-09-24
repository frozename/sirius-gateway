import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
  UsageObservationCarrier,
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
  /**
   * Per-call usage observations keyed by nova attempt id. nova's
   * `onUsageObservation` fires inside the awaited upstream call; the
   * call site then takes (and deletes) its own entry so concurrent
   * calls and policy retries never cross-attribute counts.
   */
  private readonly observations = new Map<string, nova.UsageObservationV1>();

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
      onUsageObservation: (snapshot) => {
        // Stream attempts carry no attempt_id — nothing to key them
        // by, so they are dropped rather than misattributed.
        if (snapshot.attempt_id) {
          this.observations.set(snapshot.attempt_id, snapshot.observation);
        }
      },
    });
  }

  async createResponse(
    request: SiriusReq,
    context?: nova.ProviderExecutionContext,
  ): Promise<SiriusRes & UsageObservationCarrier> {
    const novaReq = siriusRequestToNova(request);
    const attemptId = context?.attemptId ?? randomUUID();
    try {
      const novaRes = await this.nova.createResponse(
        novaReq,
        executionContext(context, request.requestId, attemptId),
      );
      const res = novaResponseToSirius(novaRes, this.name);
      const observation = this.observations.get(attemptId);
      return observation
        ? { ...res, metadata: { usageObservation: observation } }
        : res;
    } finally {
      this.observations.delete(attemptId);
    }
  }

  async *streamResponse(
    request: SiriusReq,
    signal?: AbortSignal,
  ): AsyncIterable<SiriusStreamEvent> {
    const novaReq = siriusRequestToNova(request);
    const stream = this.nova.streamResponse?.(novaReq, signal);
    if (!stream) {
      yield {
        type: 'error',
        error: `${this.name}: upstream does not support streaming`,
        code: 'stream_unsupported',
      };
      return;
    }
    let errorYielded = false;
    try {
      for await (const ev of stream) {
        if (ev.type === 'error') {
          errorYielded = true;
          yield novaStreamEventToSirius(ev)!;
          return;
        }
        if (ev.type === 'done') {
          // Truncation must surface as an error, never as a successful
          // finish — only an upstream-signalled completion maps to
          // sirius `done`.
          if (ev.completion === 'upstream') {
            yield { type: 'done', finishReason: ev.finish_reason ?? 'stop' };
          } else if (!errorYielded) {
            yield upstreamEof();
          }
          return;
        }
        const translated = novaStreamEventToSirius(ev);
        if (translated) yield translated;
      }
      // The iterable ended with no terminal event — same truncation
      // signature as an `eof` completion.
      if (!errorYielded) yield upstreamEof();
    } catch (err) {
      // A mid-stream transport failure arrives here as a throw; it
      // must become an error EVENT — the policy retries thrown errors
      // and a retry would re-emit the partial output upstream of it.
      if (!errorYielded) {
        yield {
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
          code: 'upstream_eof',
        };
      }
    }
  }

  async createEmbeddings(
    request: SiriusEmbReq,
    context?: nova.ProviderExecutionContext,
  ): Promise<SiriusEmbRes & UsageObservationCarrier> {
    if (!this.nova.createEmbeddings) {
      throw new Error(`${this.name}: embeddings not supported`);
    }
    const novaReq: nova.UnifiedEmbeddingRequest = {
      model: request.model,
      input: request.input,
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.user !== undefined ? { user: request.user } : {}),
    };
    const attemptId = context?.attemptId ?? randomUUID();
    try {
      const res = await this.nova.createEmbeddings(
        novaReq,
        executionContext(context, request.requestId, attemptId),
      );
      const observation = this.observations.get(attemptId);
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
        ...(observation ? { metadata: { usageObservation: observation } } : {}),
      };
    } finally {
      this.observations.delete(attemptId);
    }
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

/**
 * Forward the caller's execution context into the nova call, filling
 * in the per-attempt identity sirius owns: `attemptId` identifies this
 * call within a retried logical request (and keys the observation
 * map); `requestId` falls back to the sirius request's own id.
 */
function executionContext(
  context: nova.ProviderExecutionContext | undefined,
  requestId: string | undefined,
  attemptId: string,
): nova.ProviderExecutionContext {
  const rid = context?.requestId ?? requestId;
  return {
    ...(context?.signal ? { signal: context.signal } : {}),
    ...(context?.deadline !== undefined ? { deadline: context.deadline } : {}),
    ...(rid ? { requestId: rid } : {}),
    attemptId,
  };
}

function upstreamEof(): SiriusStreamEvent {
  return {
    type: 'error',
    error: 'upstream stream ended without a completion signal',
    code: 'upstream_eof',
  };
}

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
