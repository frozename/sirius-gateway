import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

@Injectable()
export class PolicyService {
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly timeoutMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerResetMs: number;
  private readonly circuitState = new Map<string, CircuitState>();

  constructor(private readonly configService: ConfigService) {
    this.maxRetries = this.configService.get<number>(
      'SIRIUS_RETRY_MAX_ATTEMPTS',
      2,
    );
    this.baseDelay = this.configService.get<number>(
      'SIRIUS_RETRY_BASE_DELAY_MS',
      500,
    );
    this.timeoutMs = this.configService.get<number>('SIRIUS_TIMEOUT_MS', 60000);
    this.circuitBreakerThreshold = this.configService.get<number>(
      'SIRIUS_CIRCUIT_BREAKER_THRESHOLD',
      5,
    );
    this.circuitBreakerResetMs = this.configService.get<number>(
      'SIRIUS_CIRCUIT_BREAKER_RESET_MS',
      30000,
    );
  }

  async executeWithPolicy<T>(
    providerName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.checkCircuitBreaker(providerName);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.withTimeout(operation());
        this.recordSuccess(providerName);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(providerName);

        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  async *executeStreamWithPolicy<T>(
    providerName: string,
    operation: () => AsyncIterable<T>,
  ): AsyncIterable<T> {
    this.checkCircuitBreaker(providerName);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const stream = operation();
        for await (const event of stream) {
          yield event;
        }
        this.recordSuccess(providerName);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(providerName);

        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  getCircuitBreakerState(provider: string): {
    isOpen: boolean;
    failures: number;
    lastFailure: number;
  } {
    const state = this.circuitState.get(provider);
    return state
      ? { ...state }
      : { isOpen: false, failures: 0, lastFailure: 0 };
  }

  private checkCircuitBreaker(provider: string): void {
    const state = this.circuitState.get(provider);
    if (!state || !state.isOpen) {
      return;
    }

    const elapsed = Date.now() - state.lastFailure;
    if (elapsed >= this.circuitBreakerResetMs) {
      state.isOpen = false;
      state.failures = 0;
      return;
    }

    throw new Error(
      `Circuit breaker is open for provider "${provider}". Retry after ${this.circuitBreakerResetMs - elapsed}ms.`,
    );
  }

  private recordSuccess(provider: string): void {
    const state = this.circuitState.get(provider);
    if (state) {
      state.failures = 0;
      state.isOpen = false;
    }
  }

  private recordFailure(provider: string): void {
    let state = this.circuitState.get(provider);
    if (!state) {
      state = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuitState.set(provider, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.circuitBreakerThreshold) {
      state.isOpen = true;
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs,
        ),
      ),
    ]);
  }
}
