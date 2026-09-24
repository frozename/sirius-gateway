import { describe, expect, it } from 'bun:test';
import { UsageRecorderService } from '../usage-recorder.service';

/**
 * A2 — when the adapter surfaces a usage observation, the recorder
 * builds a V2 record in memory and writes ONLY the V1 projection:
 * fully-observed rows land once; unknown/partial observations write
 * nothing (no fabricated zeros). Rows never carry `v` or
 * `observation` fields — the sink stays V1.
 */

const fixedNow = new Date('2026-09-24T12:00:00Z');

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

const base = {
  provider: 'llamactl-gpu1',
  model: 'm',
  kind: 'chat' as const,
  // Deliberately different from the observation counts — the
  // projection must be sourced from the observation, not these.
  promptTokens: 99,
  completionTokens: 88,
  totalTokens: 187,
  latencyMs: 12,
  requestId: 'r1',
  route: 'round-robin',
};

describe('UsageRecorderService observations (A2)', () => {
  it('writes exactly one V1 row for a fully-observed observation', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      ...base,
      observation: {
        source: 'observed',
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });
    expect(writes).toHaveLength(1);
    const rec = writes[0]!.record as Record<string, unknown>;
    expect(rec).toEqual({
      ts: '2026-09-24T12:00:00.000Z',
      provider: 'llamactl-gpu1',
      model: 'm',
      kind: 'chat',
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      latency_ms: 12,
      request_id: 'r1',
      route: 'round-robin',
    });
    expect(rec).not.toHaveProperty('v');
    expect(rec).not.toHaveProperty('observation');
  });

  it('writes nothing for source:unknown', () => {
    const { svc, writes } = makeRecorder();
    svc.record({ ...base, observation: { source: 'unknown' } });
    expect(writes).toHaveLength(0);
  });

  it('writes nothing for a partial observation on a chat call', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      ...base,
      observation: { source: 'observed', input_tokens: 10 },
    });
    expect(writes).toHaveLength(0);
  });

  it('projects an embedding observation with only input_tokens', () => {
    const { svc, writes } = makeRecorder();
    svc.record({
      ...base,
      kind: 'embedding',
      observation: { source: 'observed', input_tokens: 7 },
    });
    expect(writes).toHaveLength(1);
    const rec = writes[0]!.record as Record<string, unknown>;
    expect(rec.prompt_tokens).toBe(7);
    expect(rec.completion_tokens).toBe(0);
    expect(rec.total_tokens).toBe(7);
    expect(rec.kind).toBe('embedding');
  });

  it('writes nothing for a malformed observation', () => {
    const { svc, writes } = makeRecorder();
    svc.record({ ...base, observation: { source: 'bogus' } });
    expect(writes).toHaveLength(0);
  });

  it('the no-observation path is unchanged', () => {
    const { svc, writes } = makeRecorder();
    svc.record({ ...base });
    expect(writes).toHaveLength(1);
    const rec = writes[0]!.record as Record<string, unknown>;
    expect(rec.prompt_tokens).toBe(99);
    expect(rec.completion_tokens).toBe(88);
    expect(rec.total_tokens).toBe(187);
  });
});
