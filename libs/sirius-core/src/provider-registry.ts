import { Injectable } from '@nestjs/common';
import type { AiProvider } from './provider.interface.js';

@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();

  register(provider: AiProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): AiProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): AiProvider[] {
    return [...this.providers.values()];
  }

  getNames(): string[] {
    return [...this.providers.keys()];
  }
}
