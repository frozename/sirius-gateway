export * from './types/index';
export * from './provider.interface';
export * from './provider-registry';
export * from './core.module';

/**
 * Nova — canonical AI-provider contracts that are replacing sirius's
 * legacy camelCase types. Exposed as a namespace so the two vocabularies
 * can coexist during the migration. New code should prefer `nova.*`:
 *
 *     import { nova } from '@sirius/core';
 *     const req: nova.UnifiedAiRequest = { ... };
 *
 * Legacy sirius types (`UnifiedAiRequest`, `UnifiedAiResponse`,
 * `UnifiedStreamEvent`, `ProviderHealth`, …) remain exported directly
 * from the top of this file. They are planned for removal once every
 * provider adapter and GatewayService surface has migrated. See
 * `docs/nova-migration.md` for the per-surface plan.
 */
export * as nova from '@nova/contracts';
