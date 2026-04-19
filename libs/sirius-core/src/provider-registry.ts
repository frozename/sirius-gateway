import { Injectable } from '@nestjs/common';
import type { AiProvider } from './provider.interface.js';

@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();

  register(provider: AiProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Remove a provider by name. Returns `true` when the provider was
   * present + got removed, `false` when no provider by that name
   * existed. Used by the `/providers/reload` endpoint + the future
   * wet-mode `sirius.providers.deregister` MCP tool.
   */
  unregister(name: string): boolean {
    return this.providers.delete(name);
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
