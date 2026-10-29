import { describe, expect, test } from 'bun:test';
import { nova } from '@sirius/core';
import type {
  UnifiedAiRequest,
  UnifiedEmbeddingRequest,
  UnifiedStreamEvent,
} from '@sirius/core';
import { toSiriusAdapter } from '../fromfile-provider.module.js';

/**
 * #13: the from-file shim must hand the caller's execution context and
 * stream signal to the nova core unchanged, so a client disconnect or a
 * policy timeout aborts the upstream request. A fake core records what
 * it receives; no network is involved.
 */

interface Seen {
  responseContexts: (nova.ProviderExecutionContext | undefined)[];
  embeddingContexts: (nova.ProviderExecutionContext | undefined)[];
  streamSignals: (AbortSignal | undefined)[];
}

const novaResponse: nova.UnifiedAiResponse = {
  id: 'chatcmpl-fake',
  object: 'chat.completion',
  model: 'm',
  created: 1,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ack' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

const novaEmbeddings: nova.UnifiedEmbeddingResponse = {
  object: 'list',
  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
  model: 'emb-m',
  usage: { prompt_tokens: 2, total_tokens: 2 },
};

const chunkEvent: nova.UnifiedStreamEvent = {
  type: 'chunk',
  chunk: {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    model: 'm',
    created: 1,
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
};

const doneEvent: nova.UnifiedStreamEvent = {
  type: 'done',
  finish_reason: 'stop',
  completion: 'upstream',
};

function makeFakeCore(): { core: nova.AiProvider; seen: Seen } {
  const seen: Seen = {
    responseContexts: [],
    embeddingContexts: [],
    streamSignals: [],
  };
  const core: nova.AiProvider = {
    name: 'fake-core',
    async createResponse(
      _request: nova.UnifiedAiRequest,
      context?: nova.ProviderExecutionContext,
    ): Promise<nova.UnifiedAiResponse> {
      seen.responseContexts.push(context);
      return novaResponse;
    },
    async *streamResponse(
      _request: nova.UnifiedAiRequest,
      signal?: AbortSignal,
    ): AsyncIterable<nova.UnifiedStreamEvent> {
      seen.streamSignals.push(signal);
      yield chunkEvent;
      yield doneEvent;
    },
    async createEmbeddings(
      _request: nova.UnifiedEmbeddingRequest,
      context?: nova.ProviderExecutionContext,
    ): Promise<nova.UnifiedEmbeddingResponse> {
      seen.embeddingContexts.push(context);
      return novaEmbeddings;
    },
  };
  return { core, seen };
}

const chatReq: UnifiedAiRequest = {
  requestId: 'req-ctx',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  stream: false,
};

const embReq: UnifiedEmbeddingRequest = {
  requestId: 'req-ctx-emb',
  model: 'emb-m',
  input: 'hi',
};

describe('toSiriusAdapter forwards cancellation to the nova core (#13)', () => {
  test('createResponse passes the caller context through unchanged', async () => {
    const { core, seen } = makeFakeCore();
    const adapter = toSiriusAdapter('fake', core);
    const ctx: nova.ProviderExecutionContext = {
      signal: new AbortController().signal,
      attemptId: 'attempt-1',
    };

    const res = await adapter.createResponse(chatReq, ctx);

    expect(res.provider).toBe('fake');
    expect(seen.responseContexts).toHaveLength(1);
    expect(seen.responseContexts[0]).toBe(ctx);
    expect(seen.responseContexts[0]?.signal).toBe(ctx.signal);
    expect(seen.responseContexts[0]?.attemptId).toBe('attempt-1');
  });

  test('createResponse rejects with AbortError when the caller aborts mid-flight', async () => {
    const hangingCore: nova.AiProvider = {
      name: 'hanging-core',
      createResponse(
        _request: nova.UnifiedAiRequest,
        context?: nova.ProviderExecutionContext,
      ): Promise<nova.UnifiedAiResponse> {
        const signal = context?.signal;
        if (!signal) {
          return Promise.reject(new Error('no signal reached the core'));
        }
        return new Promise<nova.UnifiedAiResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason);
          });
        });
      },
    };
    const adapter = toSiriusAdapter('fake', hangingCore);
    const controller = new AbortController();

    const pending = adapter.createResponse(chatReq, { signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);

    expect((err as DOMException).name).toBe('AbortError');
  });

  test('createEmbeddings passes the caller context through unchanged', async () => {
    const { core, seen } = makeFakeCore();
    const adapter = toSiriusAdapter('fake', core);
    const ctx: nova.ProviderExecutionContext = {
      signal: new AbortController().signal,
      attemptId: 'attempt-2',
    };

    const res = await adapter.createEmbeddings(embReq, ctx);

    expect(res.embeddings).toEqual([[0.1, 0.2]]);
    expect(seen.embeddingContexts).toHaveLength(1);
    expect(seen.embeddingContexts[0]).toBe(ctx);
  });

  test('streamResponse passes the caller signal through unchanged', async () => {
    const { core, seen } = makeFakeCore();
    const adapter = toSiriusAdapter('fake', core);
    const controller = new AbortController();

    const events: UnifiedStreamEvent[] = [];
    for await (const event of adapter.streamResponse(chatReq, controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'content_delta', delta: 'hi' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(seen.streamSignals).toHaveLength(1);
    expect(seen.streamSignals[0]).toBe(controller.signal);
  });
});
