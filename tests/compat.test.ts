/**
 * Compatibility fence for the browser half.
 *
 * The failure this pins down is not a wrong value but a hard gate: a service
 * named in the plugin's declarative `inject` that a harness build no longer
 * provides keeps the entry's fiber pending, and the client module runner awaits
 * every entry during boot, so the page never finishes painting. These tests
 * assert the policy that prevents it — `apply` loads with nothing but the
 * platform core, each feature binds exactly when its own services exist, a
 * missing service costs one feature and names itself, and one rejected
 * registration cannot take its siblings down.
 */
// @vitest-environment node
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  fileExtension: (name: string) => name.split('.').at(-1) ?? '',
  FileTypeIcon: () => null,
  fileSizeText: (bytes: number) => `${bytes} B`,
  IconCheckOutlineRegular: () => createElement('span', { 'data-icon': 'check' }),
  IconCopyOutlineRegular: () => createElement('span', { 'data-icon': 'copy' }),
  JsonBlock: () => null,
  projectUserText: (text: string) => text,
  Tooltip: (props: { children?: unknown }) => createElement('span', {}, props.children as never),
  writeClipboard: async () => true,
}))

const { apply, inject, CAPABILITY_GRACE_MS } = await import('../src/client/index.tsx')

interface Registration {
  name: string
  options: Record<string, unknown>
}

interface Harness {
  ctx: Context
  registered: Registration[]
  /** Dependency sets whose services never arrived. */
  pending: string[][]
}

/** The feature services this build resolves optionally. */
const FEATURE_SERVICES = ['configForms', 'connection', 'sessions', 'conversation', 'uiWorkspace']

/** Every service a healthy 0.1.7 client provides to this plugin. */
const ALL_SERVICES = ['slots', 'locale', ...FEATURE_SERVICES]

/**
 * A minimal client context: services resolve from a fixed set, `inject` calls
 * back only when every dependency is present (otherwise it parks, exactly as a
 * pending child fiber does), and the harness declares the slot keys it renders.
 */
function makeHarness(options: {
  services: readonly string[]
}): Harness {
  const services = new Set(options.services)
  const declaredSlots = new Set(['plugins.bundle.config', 'conversation.view', 'conversation.chat.node'])
  const registered: Registration[] = []
  const pending: string[][] = []

  const settingsScope = {
    getSnapshot: () => ({ status: 'ready' as const, value: {}, base: {}, user: {}, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }

  const slots = {
    inject(key: string, callback: () => unknown): () => void {
      // The real service waits for another package to declare the key.
      if (!declaredSlots.has(key)) return () => {}
      const disposer = callback()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    register(options: Record<string, unknown>): () => void {
      if (options.name === undefined) throw new Error('slot registration needs a name')
      registered.push({ name: String(options.name), options })
      return () => {}
    },
  }

  const serviceFor = (name: string): unknown => {
    if (!services.has(name)) return undefined
    switch (name) {
      case 'slots':
        return slots
      case 'locale':
        return { register: () => () => {}, bind: () => (key: string) => key }
      case 'configForms':
        return {
          get: () => settingsScope,
          whileServed: (_namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
            register(new Set(['observational-memory'])),
        }
      case 'connection':
        return { rpc: { call: async () => ({ ok: false, error: { code: 'unavailable', message: 'test' } }) } }
      case 'sessions':
        return {
          binding: () => undefined,
          fork: async () => 'child',
          scope: () => undefined,
          list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
        }
      case 'conversation':
        return { input: { for: () => ({ setDraft: () => {}, notify: () => {} }) } }
      case 'uiWorkspace':
        return { openSession: () => {} }
      default:
        return undefined
    }
  }

  const ctx = {
    effect: (fn: () => unknown): (() => void) => {
      const disposer = fn()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    get: (name: string) => serviceFor(name),
    inject: (deps: readonly string[], callback: (scope: unknown) => void): unknown => {
      const list = [...deps]
      if (list.every((name) => services.has(name))) callback(ctx)
      else pending.push(list)
      return {}
    },
    locale: serviceFor('locale'),
    slots,
    ...(services.has('connection') ? { connection: serviceFor('connection') } : {}),
    ...(services.has('conversation') ? { conversation: serviceFor('conversation') } : {}),
  }
  return { ctx: ctx as unknown as Context, registered, pending }
}

/** Registration ids in the order `apply` performs them. */
function ids(harness: Harness): string[] {
  return harness.registered.map((entry) => `${entry.name}:${String(entry.options.key ?? entry.options.id ?? '')}`)
}

let warn: ReturnType<typeof vi.spyOn>

describe('client compatibility fence', () => {
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('declares only the platform core as required', () => {
    // Adding a feature service here is what bricked the page on 0.1.7: the boot
    // waits on this entry's fiber, so an unavailable name never settles.
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('loads with no feature services at all, and names what is missing', () => {
    vi.useFakeTimers()
    const harness = makeHarness({ services: ['slots', 'locale'] })

    expect(() => apply(harness.ctx)).not.toThrow()
    expect(harness.registered).toHaveLength(0)
    expect(harness.pending).toHaveLength(3)

    expect(warn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CAPABILITY_GRACE_MS + 1)

    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages).toHaveLength(3)
    expect(messages.some((m) => m.includes('settings card') && m.includes('configForms'))).toBe(true)
    expect(messages.some((m) => m.includes('Memory tab') && m.includes('connection'))).toBe(true)
    expect(messages.some((m) => m.includes('rollback button') && m.includes('sessions'))).toBe(true)
  })

  it('binds every feature when the full service set exists', () => {
    vi.useFakeTimers()
    const harness = makeHarness({ services: ALL_SERVICES })

    apply(harness.ctx)

    expect(ids(harness)).toEqual([
      'plugins.bundle.config:dsh-observational-memory',
      'conversation.view:memory',
      'conversation.chat.node:user',
      'conversation.chat.node:steering',
    ])
    expect(harness.registered.every((entry) => entry.options.locale === 'observational-memory')).toBe(true)

    vi.advanceTimersByTime(CAPABILITY_GRACE_MS + 1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the other features when configForms is gone', () => {
    vi.useFakeTimers()
    const harness = makeHarness({ services: ALL_SERVICES.filter((name) => name !== 'configForms') })

    apply(harness.ctx)

    expect(ids(harness)).toEqual([
      'conversation.view:memory',
      'conversation.chat.node:user',
      'conversation.chat.node:steering',
    ])

    vi.advanceTimersByTime(CAPABILITY_GRACE_MS + 1)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('configForms')
  })

  it('keeps the card and the tab when the rollback services are gone', () => {
    vi.useFakeTimers()
    const harness = makeHarness({
      services: ALL_SERVICES.filter((name) => !['sessions', 'conversation', 'uiWorkspace'].includes(name)),
    })

    apply(harness.ctx)

    expect(ids(harness)).toEqual([
      'plugins.bundle.config:dsh-observational-memory',
      'conversation.view:memory',
    ])

    vi.advanceTimersByTime(CAPABILITY_GRACE_MS + 1)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('rollback button')
  })

  it('renders the Memory tab without the session list', () => {
    vi.useFakeTimers()
    const harness = makeHarness({ services: ALL_SERVICES.filter((name) => name !== 'sessions') })

    apply(harness.ctx)

    // The eviction hook needs the session list; the tab itself does not, and
    // the rollback renderers still declare their own dependency on it.
    expect(ids(harness)).toEqual([
      'plugins.bundle.config:dsh-observational-memory',
      'conversation.view:memory',
    ])
  })

  it('contains a rejected registration to its own key', () => {
    vi.useFakeTimers()
    const harness = makeHarness({ services: ALL_SERVICES })
    // The chat-node recorder rejects the `user` key the way a changed option
    // shape (or another shadowing plugin's priority clash) would.
    const slots = harness.ctx.slots as unknown as {
      register: (options: Record<string, unknown>) => () => void
    }
    const original = slots.register.bind(slots)
    slots.register = (options: Record<string, unknown>) => {
      if (options.key === 'user') throw new Error('slot rejected this registration')
      return original(options)
    }

    expect(() => apply(harness.ctx)).not.toThrow()

    expect(ids(harness)).toEqual([
      'plugins.bundle.config:dsh-observational-memory',
      'conversation.view:memory',
      'conversation.chat.node:steering',
    ])
    vi.advanceTimersByTime(CAPABILITY_GRACE_MS + 1)
    const messages = warn.mock.calls.map((call) => String(call[0]))
    expect(messages.some((m) => m.includes('"user"'))).toBe(true)
  })
})
