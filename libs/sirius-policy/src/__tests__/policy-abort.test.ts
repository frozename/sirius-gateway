import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PolicyService } from '../policy.service';
import type { ProviderExecutionContext } from '@nova/contracts';

/**
 * A1 — the policy timeout must ABORT the in-flight attempt, not just
 * abandon it: previously a timed-out attempt kept running while a
 * retry fired alongside. Each attempt gets its own AbortController
 * merged with the caller signal, and the abort lands before any retry.
 */

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string, defaultValue?: unknown) => {
      if (overrides[key] !== undefined) return overrides[key];
      if (key === 'SIRIUS_RETRY_MAX_ATTEMPTS') return 1;
      if (key === 'SIRIUS_RETRY_BASE_DELAY_MS') return 10;
      if (key === 'SIRIUS_TIMEOUT_MS') return 60;
      if (key === 'SIRIUS_CIRCUIT_BREAKER_THRESHOLD') return 5;
      if (key === 'SIRIUS_CIRCUIT_BREAKER_RESET_MS') return 1000;
      return defaultValue;
    },
  };
}

const upstream = {
  arrivals: 0,
  aborts: 0,
};
const clientSide = {
  starts: [] as number[],
  aborts: [] as number[],
};

let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      upstream.arrivals++;
      req.signal.addEventListener('abort', () => {
        upstream.aborts++;
      });
      return new Promise<Response>(() => {});
    },
  });
  port = server.port;
});

afterAll(() => {
  server?.stop(true);
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('PolicyService attempt aborts (A1)', () => {
  test('timeout aborts the in-flight fetch; a retry never overlaps the aborted attempt', async () => {
    const policy = new PolicyService(makeConfig() as never);
    const attemptIds = new Set<string>();
    const arrivalsBefore = upstream.arrivals;

    const op = (ctx?: ProviderExecutionContext) => {
      if (ctx?.attemptId) attemptIds.add(ctx.attemptId);
      ctx?.signal?.addEventListener('abort', () => {
        clientSide.aborts.push(Date.now());
      });
      clientSide.starts.push(Date.now());
      return fetch(`http://127.0.0.1:${port}/hang`, {
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      }).then((r) => r.text());
    };

    const err = await policy
      .executeWithPolicy('p', op)
      .catch((e: unknown) => e);
    expect(String((err as Error)?.message ?? err)).toContain('timed out');

    // One initial attempt + one retry, each with a distinct attempt id.
    expect(upstream.arrivals - arrivalsBefore).toBe(2);
    expect(attemptIds.size).toBe(2);

    // The first attempt's abort was observed by the upstream, and the
    // retry's fetch began only after attempt 1's signal had fired.
    await until(() => upstream.aborts >= 1);
    expect(clientSide.aborts.length).toBeGreaterThanOrEqual(1);
    expect(clientSide.starts[1]!).toBeGreaterThanOrEqual(clientSide.aborts[0]!);
  });

  test('a caller abort reaches the in-flight attempt and stops retries', async () => {
    const policy = new PolicyService(makeConfig() as never);
    const caller = new AbortController();
    const arrivalsBefore = upstream.arrivals;
    const abortsBefore = upstream.aborts;

    const op = (ctx?: ProviderExecutionContext) =>
      fetch(`http://127.0.0.1:${port}/hang`, {
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      }).then((r) => r.text());

    const pending = policy.executeWithPolicy('p', op, caller.signal);
    await until(() => upstream.arrivals > arrivalsBefore);
    caller.abort(new Error('client went away'));

    const err = await pending.catch((e: unknown) => e);
    expect(String((err as Error)?.message ?? err)).toContain('client went away');
    await until(() => upstream.aborts > abortsBefore);
    // No retry after a caller abort.
    expect(upstream.arrivals - arrivalsBefore).toBe(1);
  });
});
