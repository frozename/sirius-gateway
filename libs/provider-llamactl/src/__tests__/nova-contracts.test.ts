import { describe, expect, test } from 'bun:test';
import {
  StreamCompletionSchema,
  projectUsageRecordV2ToV1,
} from '@nova/contracts';

/**
 * Install tripwire — the P0.2 consumer lanes require @nova/contracts
 * 0.2.0. On 0.1.0 this module fails to import (the exports don't
 * exist), so this file can't even run; on 0.2.0 the assertions hold.
 */
describe('@nova/contracts 0.2.0 surface', () => {
  test('projectUsageRecordV2ToV1 is exported', () => {
    expect(typeof projectUsageRecordV2ToV1).toBe('function');
  });

  test("StreamCompletionSchema includes 'eof'", () => {
    expect(StreamCompletionSchema.options).toContain('eof');
    expect(StreamCompletionSchema.options).toContain('upstream');
  });
});
