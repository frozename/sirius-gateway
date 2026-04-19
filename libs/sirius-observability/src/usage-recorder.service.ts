import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { appendUsageBackground, defaultUsageDir } from '@nova/mcp-shared';
import { UsageRecordSchema, type UsageRecord } from '@nova/contracts';

export const USAGE_RECORDER_DEPS = Symbol('USAGE_RECORDER_DEPS');

/**
 * Per-request usage recorder (N.3.2).
 *
 * Writes one JSONL line per sirius-mediated upstream call into
 * `~/.llamactl/usage/<provider>-<YYYY-MM-DD>.jsonl` (or
 * $LLAMACTL_USAGE_DIR / $DEV_STORAGE/usage). Same sink shape as the
 * audit module — one provider per file, rotated by UTC day. Zod-
 * validated against UsageRecordSchema at the boundary so a malformed
 * record never lands on disk (validation error logged, original
 * request unaffected).
 *
 * Policy: fire-and-forget through `queueMicrotask`. The controller
 * has already responded to the user by the time the write runs;
 * errors are swallowed so a full disk can't bleed into request
 * latency.
 *
 * Streaming responses are NOT instrumented here — their usage totals
 * arrive only in the final SSE chunk (when `stream_options:
 * {include_usage: true}` is set) and require aggregation state the
 * controllers don't carry today. That's N.3.3.
 */

export type UsageKind = 'chat' | 'embedding' | 'responses';

export interface UsageRecorderInput {
  provider: string;
  model: string;
  kind: UsageKind;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  requestId?: string;
  /** Optional routing tag — embersynth profile id, sirius route slug,
   *  or anything else that helps later aggregation. */
  route?: string;
  /** Optional user tag — callers opt in; privacy-first default is to
   *  leave this blank. */
  user?: string;
}

export interface UsageRecorderDeps {
  /** Overrideable dir for tests. Falls back to `defaultUsageDir()`. */
  dir?: string;
  /** Clock injection. */
  now?: () => Date;
  /** Swap the writer — tests inject a synchronous capturer. */
  writer?: (opts: { record: unknown; dir?: string; now?: () => Date }) => void;
  /** Schedule-on-microtask hook. Defaults to queueMicrotask; tests
   *  pass an immediate runner so they can assert the write synchronously. */
  schedule?: (fn: () => void) => void;
}

@Injectable()
export class UsageRecorderService {
  private readonly logger = new Logger(UsageRecorderService.name);
  private readonly deps: Required<UsageRecorderDeps>;

  constructor(
    @Optional() @Inject(USAGE_RECORDER_DEPS) deps?: UsageRecorderDeps,
  ) {
    this.deps = {
      dir: deps?.dir ?? defaultUsageDir(),
      now: deps?.now ?? (() => new Date()),
      writer: deps?.writer ?? appendUsageBackground,
      schedule: deps?.schedule ?? queueMicrotask,
    };
  }

  record(input: UsageRecorderInput): void {
    // Build the record first so schema validation runs on the hot
    // thread — a malformed record should never get queued and then
    // drop silently. The write itself (disk I/O) is deferred.
    let validated: UsageRecord;
    try {
      const candidate: Record<string, unknown> = {
        ts: this.deps.now().toISOString(),
        provider: input.provider,
        model: input.model,
        kind: input.kind,
        prompt_tokens: input.promptTokens,
        completion_tokens: input.completionTokens,
        total_tokens: input.totalTokens,
        latency_ms: input.latencyMs,
      };
      if (input.requestId !== undefined) candidate.request_id = input.requestId;
      if (input.route !== undefined) candidate.route = input.route;
      if (input.user !== undefined) candidate.user = input.user;
      validated = UsageRecordSchema.parse(candidate);
    } catch (err) {
      this.logger.warn({
        msg: 'usage record failed validation — skipping write',
        error: err instanceof Error ? err.message : String(err),
        input,
      });
      return;
    }
    this.deps.schedule(() => {
      this.deps.writer({
        record: validated,
        dir: this.deps.dir,
        now: this.deps.now,
      });
    });
  }
}
