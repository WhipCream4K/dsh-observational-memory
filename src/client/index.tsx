/**
 * dsh-observational-memory — browser half.
 *
 * Three independent features, each bound only when the services it actually
 * needs exist:
 *  - the bilingual dictionaries (the platform `locale` service),
 *  - the configuration card on this bundle's page under Plugins
 *    (`configForms`, keyed by the `observational-memory` settings entry the host
 *    half serves, with the model catalog over the Connection RPC),
 *  - the Memory conversation view tab (`connection`), and the rollback-enabled
 *    user message renderers (`sessions` + `conversation` + `uiWorkspace`).
 *
 * Only the platform core (`slots`, `locale`) is declared in `inject`, because
 * a service named there is a hard gate: the client module runner awaits every
 * entry's fiber during boot, so a service this harness build no longer provides
 * would leave the page waiting instead of painting. Feature services are
 * resolved through optional child fibers, which is what makes a renamed service
 * cost one feature rather than the whole chat.
 *
 * @module dsh-observational-memory/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { ObservationalMemoryCard } from './card.tsx'
import { CARD_FIELDS, OmCardController, type SettingsScopeLike } from './controller.ts'
import { en, LOCALE_NAMESPACE, zh } from './locales.ts'
import { MemoryView } from './memory.tsx'
import { OmMemoryController, type ConnectionRpcLike, type MemoryViewMode } from './memory.ts'
import type { RollbackEventView } from './rollback.ts'
import { OmUserMessageNodeView, type RollbackInjected } from './user-message.tsx'

export const name = 'dsh-observational-memory-ui'

/**
 * Platform core only. Every feature service is resolved through
 * {@link optionalFeature}, so no renamed or absent feature service can keep
 * this entry's fiber pending and stall the client boot.
 */
export const inject = ['slots', 'locale']

/** The settings namespace joining the host half and this card. */
const NS = LOCALE_NAMESPACE

/**
 * How long a feature waits for its services before saying so. Long enough that
 * a healthy boot never trips it (services arrive with the shell), short enough
 * to beat a user noticing a missing card and wondering why.
 */
export const CAPABILITY_GRACE_MS = 10_000

interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string) => string
}

interface SlotsService {
  /** Run the registration once the slot key is declared; returns its disposer. */
  inject(key: string, callback: () => unknown): () => void
  register(
    options: {
      name: string
      key?: string
      id?: string
      order?: number
      priority?: number
      label?: string | (() => string)
      locale?: string
      inject?: (...args: never[]) => Record<string, unknown>
    },
    component: (props: never) => ReactNode,
  ): () => void
}

/**
 * The `configForms` service as this plugin needs it. DSH 0.1.7 replaced the
 * per-namespace `settingsScope` binder with one shared service over the
 * settings describe mirror; an entry is addressed by its profile entry id,
 * which for this bundle is {@link NS}.
 */
interface ConfigFormsLike {
  /** The shared form values and write queue for one Host plugin entry. */
  get(namespace: string): SettingsScopeLike
  /**
   * Run a registration while the Host serves any of these namespaces, and drop
   * it when none is served: a deployment that never mounted the Host half shows
   * no trace of the settings page.
   */
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/** The workspace navigation slice used to open a forked branch. */
interface UiWorkspaceLike {
  /** Display a known session identity; DSH 0.1.7 moved `sessions.open` here. */
  openSession(sessionId: string): void
}

interface ConnectionService {
  rpc: ConnectionRpcLike
}

/** The client Session-service slice the rollback action consumes. The
 *  `sessions` key already carries the host-side SessionStore merge in this
 *  program, so the client face is resolved through ctx.get instead of a
 *  conflicting declaration merge. */
interface SessionsService {
  binding(id: string): {
    eventSource: { getSnapshot(): { entries: readonly { event: RollbackEventView }[]; hasMore: boolean } }
  } | undefined
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }): Promise<string>
  scope(id: string): unknown
  list: { getSnapshot(): { byId: Record<string, unknown> }; subscribe(listener: () => void): () => void }
}

/** The conversation-service slice used to seed the forked session's draft. */
interface ConversationService {
  input: {
    for(scope: unknown): { setDraft(text: string): void; notify(level: 'info' | 'error', text: string): void }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleService
    slots: SlotsService
    connection: ConnectionService
    conversation: ConversationService
  }
}

const dictionaries: Record<string, Record<string, string>> = { zh, en }

/** The injected face the Memory tab's slot entry composes as props. */
interface MemoryInjected {
  hooks: { memory: OmMemoryController }
  refresh: () => void
  run: () => void
  setViewMode: (mode: MemoryViewMode) => void
}

/** Report one degraded or failed feature without taking anything else down. */
function reportCapability(feature: string, detail: string): void {
  console.warn(`[observational-memory] ${feature} unavailable: ${detail}`)
}

/**
 * Bind one feature block once its services exist, without requiring them.
 *
 * `bind` runs in a child fiber once every name in `deps` is provided, so the
 * entry itself loads immediately on any harness build. When the services never
 * arrive, one late check names the missing capability instead of leaving a
 * silent gap; a `bind` that throws (a changed registration option shape, say)
 * is contained to this block.
 *
 * @param ctx - the plugin context.
 * @param deps - services this block cannot work without.
 * @param feature - feature name used in diagnostics.
 * @param bind - the block's body, run with the child context.
 */
function optionalFeature(
  ctx: Context,
  deps: readonly string[],
  feature: string,
  bind: (scope: Context) => void,
): void {
  let settled = false
  ctx.inject([...deps], (scope: Context) => {
    settled = true
    try {
      bind(scope)
    } catch (error) {
      reportCapability(feature, `registration failed (${error instanceof Error ? error.message : String(error)})`)
    }
  })
  ctx.effect(() => {
    const timer = setTimeout(() => {
      if (settled) return
      const missing = deps.filter((name) => ctx.get(name) === undefined)
      reportCapability(feature, missing.length > 0
        ? `${missing.join(', ')} is not provided by this DeepSeek Harness build`
        : `${deps.join(', ')} never became available`)
    }, CAPABILITY_GRACE_MS)
    return () => clearTimeout(timer)
  }, `observational-memory: ${feature} diagnostic`)
}

export function apply(ctx: Context): void {
  // Bilingual dictionaries; the locale service follows the DSH language
  // setting and re-renders locale-declaring slot entries on switch.
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'observational-memory: dictionaries')

  // Bound translator shared by the tab label thunk and rollback notices.
  const t = ctx.locale.bind(NS)

  registerSettingsCard(ctx)
  registerMemoryView(ctx, t)
  registerRollbackRenderers(ctx, t)
}

/**
 * The configuration card on this bundle's page under Plugins.
 * `plugins.bundle.config` is keyed by package name and rendered `view: 'page'`
 * only; `plugins.item` is reserved for the shipped companion pages. The
 * `whileServed` guard keeps the registration alive only while the Host serves
 * this entry's settings namespace.
 */
function registerSettingsCard(ctx: Context): void {
  optionalFeature(ctx, ['configForms'], 'settings card', (scope) => {
    const configForms = scope.get('configForms') as unknown as ConfigFormsLike
    // The model catalog is the card's only use of the RPC channel, so a missing
    // connection costs the dropdowns, not the card.
    const rpc = (scope.get('connection') as ConnectionService | undefined)?.rpc
    const controller = new OmCardController(configForms.get(NS), CARD_FIELDS, rpc)
    scope.effect(() => () => controller.dispose(), 'observational-memory: card form subscription')

    scope.effect(
      () => configForms.whileServed([NS], () =>
        scope.slots.inject('plugins.bundle.config', () =>
          scope.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-observational-memory',
              locale: NS,
              inject: () => controller.inject() as unknown as Record<string, unknown>,
            },
            ObservationalMemoryCard as never,
          ),
        ),
      ),
      'observational-memory: settings page',
    )
  })
}

/**
 * The Memory conversation view tab: one controller per session, built on first
 * render of the tab's inject face and reused across remounts (view switches).
 * Controllers for sessions removed from the list are evicted when the client
 * session list is available.
 */
function registerMemoryView(ctx: Context, t: (key: string) => string): void {
  optionalFeature(ctx, ['connection'], 'Memory tab', (scope) => {
    const rpc = (scope.get('connection') as ConnectionService).rpc
    const sessions = scope.get('sessions') as unknown as SessionsService | undefined

    const memoryControllers = new Map<string, OmMemoryController>()
    if (sessions !== undefined) {
      scope.effect(() => sessions.list.subscribe(() => {
        const listed = sessions.list.getSnapshot().byId
        for (const id of [...memoryControllers.keys()]) {
          if (!(id in listed)) memoryControllers.delete(id)
        }
      }), 'observational-memory: memory controller eviction')
    }

    scope.slots.inject('conversation.view', () =>
      scope.slots.register(
        {
          name: 'conversation.view',
          id: 'memory',
          order: 20,
          locale: NS,
          label: () => t('view.memory'),
          inject: ((sessionId: string): MemoryInjected => {
            let memory = memoryControllers.get(sessionId)
            if (memory === undefined) {
              memory = new OmMemoryController(rpc, sessionId)
              memoryControllers.set(sessionId, memory)
            }
            return {
              hooks: { memory },
              refresh: () => void memory.refresh(),
              run: () => void memory.run(),
              setViewMode: (mode) => void memory.setViewMode(mode),
            }
          }) as never,
        },
        MemoryView as never,
      ),
    )
  })
}

/**
 * Rollback-enabled user message renderers. `conversation.chat.node` has no
 * additive seam for user-message actions, so the keyed `user`/`steering`
 * renderers are replaced while this plugin is loaded; the built-ins return on
 * unload. Each key's register is guarded so a priority clash with another
 * shadowing plugin cannot take the sibling key down.
 */
function registerRollbackRenderers(ctx: Context, t: (key: string) => string): void {
  optionalFeature(ctx, ['sessions', 'conversation', 'uiWorkspace'], 'rollback button', (scope) => {
    const sessions = scope.get('sessions') as unknown as SessionsService
    const uiWorkspace = scope.get('uiWorkspace') as unknown as UiWorkspaceLike

    const composerNotice = (sessionId: string, level: 'info' | 'error', text: string): void => {
      const target = sessions.scope(sessionId)
      if (target !== undefined) scope.conversation.input.for(target).notify(level, text)
    }
    const rollbackInject = (sessionId: string): RollbackInjected => ({
      rollbackWindow: () => {
        const snapshot = sessions.binding(sessionId)?.eventSource.getSnapshot()
        return {
          entries: snapshot?.entries.map((entry) => entry.event) ?? [],
          hasMore: snapshot?.hasMore ?? false,
        }
      },
      rollback: (anchorSeq, text) => {
        void sessions
          .fork({ sessionId, atSeq: anchorSeq, increaseTitle: true })
          .then((childId) => {
            // Seed the draft BEFORE opening so the child's composer adopts it on
            // mount (the draft mirror adopts on bind).
            const target = sessions.scope(childId)
            if (target !== undefined) scope.conversation.input.for(target).setDraft(text)
            uiWorkspace.openSession(childId)
          })
          .catch(() => {
            // Fork or child-title failure leaves the source view unchanged; say
            // so on the source session's composer instead of failing silently.
            composerNotice(sessionId, 'error', t('message.rollbackFailed'))
          })
      },
      notifyRollbackBlocked: () => composerNotice(sessionId, 'info', t('message.rollbackBlocked')),
    })

    scope.slots.inject('conversation.chat.node', () => {
      // Same-key replacement requires a distinct priority; the lowest value
      // renders, so -1 shadows the built-in renderer (priority 0) while loaded.
      const disposers: (() => void)[] = []
      for (const key of ['user', 'steering'] as const) {
        try {
          disposers.push(scope.slots.register(
            { name: 'conversation.chat.node', key, locale: NS, priority: -1, inject: rollbackInject as never },
            OmUserMessageNodeView as never,
          ))
        } catch (error) {
          reportCapability(`rollback-enabled renderer for chat node "${key}"`, String(error))
        }
      }
      return disposers
    })
  })
}
