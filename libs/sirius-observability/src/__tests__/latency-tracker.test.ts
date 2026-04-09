import { expect, test, describe, beforeEach } from 'bun:test';
import { LatencyTracker } from '../latency-tracker.service';

describe('LatencyTracker', () => {
  let tracker: LatencyTracker;

  beforeEach(() => {
    tracker = new LatencyTracker();
  });

  test('stores latency for a provider', () => {
    tracker.record('openai', 150);
    expect(tracker.getAverageLatency('openai')).toBe(150);
  });

  test('maintains sliding window of WINDOW_SIZE=10', () => {
    for (let i = 1; i <= 15; i++) {
      tracker.record('openai', i * 10);
    }
    // Items 6 through 15: 60, 70, 80, 90, 100, 110, 120, 130, 140, 150
    // Sum = 1050, Avg = 105
    expect(tracker.getAverageLatency('openai')).toBe(105);
  });

  test('returns undefined for unknown provider', () => {
    expect(tracker.getAverageLatency('unknown')).toBeUndefined();
  });

  test('returns single value', () => {
    tracker.record('anthropic', 200);
    expect(tracker.getAverageLatency('anthropic')).toBe(200);
  });

  test('returns correct average', () => {
    tracker.record('anthropic', 100);
    tracker.record('anthropic', 200);
    tracker.record('anthropic', 300);
    expect(tracker.getAverageLatency('anthropic')).toBe(200);
  });

  test('returns empty object when no data', () => {
    expect(tracker.getAllAverages()).toEqual({});
  });

  test('returns averages for all providers', () => {
    tracker.record('openai', 100);
    tracker.record('openai', 200);
    tracker.record('anthropic', 300);
    
    expect(tracker.getAllAverages()).toEqual({
      openai: 150,
      anthropic: 300,
    });
  });

  test('excludes providers with no data', () => {
    tracker.record('openai', 100);
    // Directly manipulating private member to simulate an empty array
    tracker['latencies'].set('empty-provider', []);
    
    expect(tracker.getAllAverages()).toEqual({
      openai: 100,
    });
  });
});
