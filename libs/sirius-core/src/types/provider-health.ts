export type ProviderStatus = 'healthy' | 'degraded' | 'down';

export interface ProviderHealth {
  provider: string;
  status: ProviderStatus;
  latencyMs?: number;
  lastChecked: Date;
  error?: string;
}
