/**
 * dsh-observational-memory — host half.
 *
 * Background memory workers (observer → reflector → dropper) distill the
 * session into a plugin-owned per-session ledger while the agent works; when
 * DSH compacts, the rendered memory projection answers the summarization call
 * (no model round-trip). The `recall` tool recovers exact source evidence
 * behind any memory id.
 *
 * Configuration lives in the `observational-memory` settings namespace
 * (Settings → Plugins → Plugin configuration), layered over the cordis
 * composition entry; the harness's own configuration is never touched.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: service merges for ctx.settings / ctx.agents / ctx.llm / ctx.sessions.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { Config, SETTINGS_NAMESPACE, readConfig, type ConfigRefs } from './config.ts'
import { OmRuntime } from './runtime.ts'
import { OmApiService } from './api.ts'
import { registerCompactionHook } from './hooks/compaction.ts'
import { registerConsolidationTrigger } from './hooks/consolidation.ts'
import { registerCompactionTrigger } from './hooks/proactive.ts'
import { registerRecallTool } from './tools/recall.ts'

export const name = 'observational-memory'
export const inject = ['llm', 'tools', 'sessions', 'agents']

export { Config, SETTINGS_NAMESPACE }
export type { Config as ConfigShape } from './config.ts'

export function apply(ctx: Context, config: ConfigRefs): void {
  // Every field is a volatile reference the Loader keeps current, so the
  // runtime reads the live values on each access: a settings-page edit lands
  // without remounting this plugin, and there is nothing to install here.
  const runtime = new OmRuntime(() => readConfig(config), {
    onError: (message) => ctx.logger.warn(message),
  })

  // This plugin ships its own configuration page (Settings → Plugins), so the
  // entry must not also get a schema-generated page. DSH 0.1.7 replaced the
  // old settings.installSection hook with Loader-owned volatile config plus
  // this page-policy registration.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'observational-memory: settings page policy',
    )
  })

  registerConsolidationTrigger(ctx, runtime)
  registerCompactionHook(ctx, runtime)
  registerCompactionTrigger(ctx, runtime)
  registerRecallTool(ctx, runtime)

  // Typert Remote endpoints feeding the browser Memory tab (`/om:status`,
  // `/om:view` and debug-log tails). With no API Gateway mounted (headless
  // runs) the service simply never gets called.
  ctx.plugin(OmApiService, runtime)
}
