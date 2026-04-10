import { Injectable } from '@nestjs/common';

@Injectable()
export class LatencyTracker {
  private readonly latencies = new Map<string, number[]>();
  private readonly WINDOW_SIZE = 10;

  record(provider: string, latencyMs: number): void {
    const history = this.latencies.get(provider) ?? [];
    history.push(latencyMs);
    if (history.length > this.WINDOW_SIZE) {
      history.shift();
    }
    this.latencies.set(provider, history);
  }

  getAverageLatency(provider: string): number | undefined {
    const history = this.latencies.get(provider);
    if (!history || history.length === 0) return undefined;
    const sum = history.reduce((a, b) => a + b, 0);
    return sum / history.length;
  }

  getAllAverages(): Record<string, number> {
    const averages: Record<string, number> = {};
    for (const provider of this.latencies.keys()) {
      const avg = this.getAverageLatency(provider);
      if (avg !== undefined) averages[provider] = avg;
    }
    return averages;
  }
}
