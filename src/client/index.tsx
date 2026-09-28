/**
 * dsh-observational-memory — browser half.
 *
 * Registers the plugin's bilingual dictionaries, one expandable card under
 * Settings → Plugins → Plugin configuration (keyed by the `observational-memory`
 * settings namespace the host half serves), and the Memory conversation view
 * tab right of the Trajectory tab, fed by the host's Typert Remote endpoints.
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
export const inject = ['slots', 'locale', 'configForms', 'connection', 'sessions', 'conversation', 'uiWorkspace']

/** The settings namespace joining the host half and this card. */
const NS = LOCALE_NAMESPACE

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

export function apply(ctx: Context): void {
  // Bilingual dictionaries; the locale service follows the DSH language
  // setting and re-renders locale-declaring slot entries on switch.
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'observational-memory: dictionaries')

  // Bound translator shared by the tab label thunk and rollback notices.
  const t = ctx.locale.bind(NS)

  // Both services are declared by the shipped client packages with shapes this
  // bundle does not want to merge against, so they are resolved structurally
  // (the same treatment `sessions` gets below); `inject` guarantees presence.
  const configForms = ctx.get('configForms') as unknown as ConfigFormsLike
  const uiWorkspace = ctx.get('uiWorkspace') as unknown as UiWorkspaceLike

  // The settings card edits the entry's volatile fields and lists the Host
  // model catalog (session/modelCatalog over the Connection RPC channel) in
  // its provider → model → reasoning-effort dropdowns.
  const controller = new OmCardController(configForms.get(NS), CARD_FIELDS, ctx.connection.rpc)
  ctx.effect(() => () => controller.dispose(), 'observational-memory: card form subscription')

  // The configuration seat on this bundle's own page in Settings → Plugins.
  // `plugins.bundle.config` is keyed by package name and rendered `view: 'page'`
  // only; `plugins.item` is reserved for the shipped companion pages. The
  // `whileServed` guard keeps the registration alive only while the Host serves
  // this entry's settings namespace.
  ctx.effect(
    () => configForms.whileServed([NS], () =>
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
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

  // Rollback-enabled user message renderers. `conversation.chat.node` has no
  // additive seam for user-message actions, so the keyed `user`/`steering`
  // renderers are replaced while this plugin is loaded; the built-ins return
  // on unload.
  const sessions = ctx.get('sessions') as unknown as SessionsService
  const composerNotice = (sessionId: string, level: 'info' | 'error', text: string): void => {
    const scope = sessions.scope(sessionId)
    if (scope !== undefined) ctx.conversation.input.for(scope).notify(level, text)
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
          const scope = sessions.scope(childId)
          if (scope !== undefined) ctx.conversation.input.for(scope).setDraft(text)
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
  ctx.slots.inject('conversation.chat.node', () => {
    // Same-key replacement requires a distinct priority; the lowest value
    // renders, so -1 shadows the built-in renderer (priority 0) while loaded.
    // A priority clash with another shadowing plugin must not take down this
    // plugin's unrelated registrations, so each register is guarded.
    const disposers: (() => void)[] = []
    for (const key of ['user', 'steering'] as const) {
      try {
        disposers.push(ctx.slots.register(
          { name: 'conversation.chat.node', key, locale: NS, priority: -1, inject: rollbackInject as never },
          OmUserMessageNodeView as never,
        ))
      } catch (error) {
        console.warn('[observational-memory] failed to register the rollback-enabled renderer for chat node "%s": %s', key, String(error))
      }
    }
    return disposers
  })

  // Memory view tab: one controller per session, built on first render of the
  // tab's inject face and reused across remounts (view switches). Controllers
  // for sessions removed from the list are evicted with it.
  const memoryControllers = new Map<string, OmMemoryController>()
  ctx.effect(() => sessions.list.subscribe(() => {
    const listed = sessions.list.getSnapshot().byId
    for (const id of [...memoryControllers.keys()]) {
      if (!(id in listed)) memoryControllers.delete(id)
    }
  }), 'observational-memory: memory controller eviction')
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'memory',
        order: 20,
        locale: NS,
        label: () => t('view.memory'),
        inject: ((sessionId: string): MemoryInjected => {
          let memory = memoryControllers.get(sessionId)
          if (memory === undefined) {
            memory = new OmMemoryController(ctx.connection.rpc, sessionId)
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
}
