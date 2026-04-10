export interface RoutingDecision {
  selectedProvider: string;
  selectedModel: string;
  strategy: string;
  reason: string;
  fallbackChain: string[];
  attemptNumber: number;
}
