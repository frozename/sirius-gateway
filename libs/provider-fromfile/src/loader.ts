import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads the sirius-providers.yaml file llamactl maintains via
 * `llamactl sirius add-provider`. One file, many providers, all
 * registered with sirius at boot.
 *
 * File location: `$LLAMACTL_PROVIDERS_FILE` env var, or
 * `$DEV_STORAGE/sirius-providers.yaml`, or
 * `~/.llamactl/sirius-providers.yaml`.
 */

export interface SiriusProviderFileEntry {
  name: string;
  kind: 'openai' | 'anthropic' | 'together' | 'groq' | 'mistral' | 'openai-compatible';
  apiKeyRef?: string;
  baseUrl?: string;
  displayName?: string;
}

export function resolveFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_PROVIDERS_FILE?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'sirius-providers.yaml');
}

export function loadProvidersFile(
  path: string = resolveFilePath(),
): SiriusProviderFileEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as
    | { providers?: SiriusProviderFileEntry[] }
    | null
    | undefined;
  if (!parsed || !Array.isArray(parsed.providers)) return [];
  return parsed.providers.filter(
    (p): p is SiriusProviderFileEntry =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as SiriusProviderFileEntry).name === 'string' &&
      typeof (p as SiriusProviderFileEntry).kind === 'string',
  );
}

/**
 * Resolve an `apiKeyRef` (`$VAR` or file path) to the raw key.
 * Returns empty string when the ref is absent, invalid, or the
 * upstream provider is anonymous (openai-compatible on localhost).
 */
export function resolveApiKeyRef(
  apiKeyRef: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!apiKeyRef) return '';
  const trimmed = apiKeyRef.trim();
  if (trimmed.startsWith('$')) {
    return (env[trimmed.slice(1)] ?? '').trim();
  }
  const path = trimmed.replace(/^~(?=$|\/)/, env.HOME ?? homedir());
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trim();
}
