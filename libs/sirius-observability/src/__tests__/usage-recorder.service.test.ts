import { describe, it, expect } from 'bun:test';
import { UsageRecorderService } from '../usage-recorder.service';

/**
 * Unit tests for the UsageRecorderService.
 *
 * We bypass the real appendUsageBackground by injecting a capturing
 * writer + an immediate scheduler — that lets us assert the record
 * shape synchronously without touching disk.
 */

describe('UsageRecorderService', () => {
  const fixedNow = new Date('2026-04-18T12:00:00Z');

  function makeRecorder() {
    const writes: Array<{ record: unknown; dir?: string }> = [];
    const svc = new UsageRecorderService({
      dir: '/tmp/fake',
      now: () => fixedNow,
      schedule: (fn) => fn(),
      writer: (opts) => {
        writes.push({ record: opts.record, dir: opts.dir });
      },
    });
    return { svc, writes };
  }

  it('writes a UsageRecord-shaped object with stamped ts', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      provider: 'openai',
      model: 'gpt-4o',
      kind: 'chat',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 200,
      requestId: 'req-123',
      route: 'round-robin',
    });
    expect(writes).toHaveLength(1);
    const rec = writes[0]!.record as Record<string, unknown>;
    expect(rec).toEqual({
      ts: '2026-04-18T12:00:00.000Z',
      provider: 'openai',
      model: 'gpt-4o',
      kind: 'chat',
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      latency_ms: 200,
      request_id: 'req-123',
      route: 'round-robin',
    });
    expect(writes[0]!.dir).toBe('/tmp/fake');
  });

  it('omits optional fields when not supplied', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      provider: 'anthropic',
      model: 'claude-opus',
      kind: 'chat',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      latencyMs: 42,
    });
    const rec = writes[0]!.record as Record<string, unknown>;
    expect(rec.request_id).toBeUndefined();
    expect(rec.route).toBeUndefined();
    expect(rec.user).toBeUndefined();
  });

  it('skips write + logs when schema validation fails (negative tokens)', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      provider: 'openai',
      model: 'gpt-4o',
      kind: 'chat',
      promptTokens: -1,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 200,
    });
    expect(writes).toHaveLength(0);
  });

  it('skips write when kind is not one of the allowed values', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      provider: 'openai',
      model: 'gpt-4o',
      // @ts-expect-error — exercise runtime guard
      kind: 'image',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      latencyMs: 1,
    });
    expect(writes).toHaveLength(0);
  });

  it('defers the write to the supplied scheduler (fire-and-forget policy)', () => {
    const scheduled: Array<() => void> = [];
    const writes: Array<{ record: unknown }> = [];
    const svc = new UsageRecorderService({
      dir: '/tmp/fake',
      now: () => fixedNow,
      schedule: (fn) => scheduled.push(fn),
      writer: (opts) => {
        writes.push({ record: opts.record });
      },
    });
    svc.record({
      provider: 'openai',
      model: 'gpt-4o',
      kind: 'embedding',
      promptTokens: 1,
      completionTokens: 0,
      totalTokens: 1,
      latencyMs: 10,
    });
    // Nothing wrote yet — scheduled but not executed.
    expect(writes).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    // Flush.
    scheduled[0]!();
    expect(writes).toHaveLength(1);
  });

  it('embedding + responses kinds also land cleanly', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      provider: 'openai',
      model: 'text-embedding-3-small',
      kind: 'embedding',
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      latencyMs: 50,
    });
    svc.record({
      provider: 'openai',
      model: 'gpt-5',
      kind: 'responses',
      promptTokens: 20,
      completionTokens: 30,
      totalTokens: 50,
      latencyMs: 150,
    });
    expect(writes).toHaveLength(2);
    expect((writes[0]!.record as { kind: string }).kind).toBe('embedding');
    expect((writes[1]!.record as { kind: string }).kind).toBe('responses');
  });
});
