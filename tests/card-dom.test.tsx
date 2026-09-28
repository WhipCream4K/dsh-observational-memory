// @vitest-environment happy-dom
/**
 * Interaction tests for the settings card: real DOM mounting so the
 * mode-dependent threshold display and the provider → model → reasoning
 * effort cascade run through the controller, not a mocked projection.
 */
import { act } from 'react'
import { createElement, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ObservationalMemoryCard } from '../src/client/card.tsx'
import {
  CARD_FIELDS,
  OmCardController,
  type CatalogRpcLike,
  type OmCardState,
  type SettingsScopeLike,
} from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

declare global {
  // React 18 act environment flag.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const t = (key: string): string => (en as Record<string, string>)[key] ?? key

/** Apply a path-addressed set the way the Host settings document does. */
function applySet(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]] = value
}

/** Apply a path-addressed unset. */
function applyUnset(target: Record<string, unknown>, path: string[]): void {
  let node = target
  for (const key of path.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object') return
    node = node[key] as Record<string, unknown>
  }
  delete node[path[path.length - 1]]
}

function fakeScope(initial: { value?: Record<string, unknown>; user?: Record<string, unknown> }) {
  let user: Record<string, unknown> = { ...(initial.user ?? {}) }
  const listeners = new Set<() => void>()
  const scope: SettingsScopeLike = {
    getSnapshot: () => ({
      status: 'ready',
      value: { observeAfterTokens: 10_000, compactAfterTokens: 0, compactAfterTokensMode: 'calibrated', ...(initial.value ?? {}), ...user },
      base: {},
      user,
      revision: 1,
      writable: true,
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops) => {
      const next = { ...user }
      for (const op of ops) {
        if (op.op === 'set') applySet(next, op.path, op.value)
        else applyUnset(next, op.path)
      }
      user = next
      for (const listener of [...listeners]) listener()
      return true
    },
  }
  return scope
}

const CATALOG = {
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'DeepSeek-V4-Flash',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  ],
  failures: [],
}

const catalogRpc: CatalogRpcLike = {
  call: (channel, endpoint) =>
    Promise.resolve(
      endpoint === 'session/modelCatalog'
        ? { ok: true as const, value: CATALOG }
        : { ok: false as const, error: { code: 'unknown', message: `unknown endpoint ${endpoint} on ${channel}` } },
    ),
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function mount(scope: SettingsScopeLike) {
  const controller = new OmCardController(scope, CARD_FIELDS, catalogRpc)
  const face = controller.inject()
  const useOmCard = <S,>(selector: (state: OmCardState) => S): S =>
    useSyncExternalStore(face.hooks.omCard.subscribe, () => selector(face.hooks.omCard.getSnapshot()))
  act(() => {
    root.render(
      createElement(ObservationalMemoryCard, {
        t,
        useOmCard,
        edit: face.edit,
        resetField: face.resetField,
        save: face.save,
        discard: face.discard,
        retryCatalog: face.retryCatalog,
      }),
    )
  })
  return face
}

function expand(): void {
  const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
  expect(header).not.toBeNull()
  act(() => header!.click())
}

function select(id: string): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(`select#${CSS.escape(id)}`)
}

function selectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function optionValues(el: HTMLSelectElement): string[] {
  return [...el.options].map((option) => option.value)
}

async function save(): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent === en['action.save'])
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

describe('ObservationalMemoryCard threshold display', () => {
  it('shows only the calibrated threshold in calibrated mode', async () => {
    mount(fakeScope({}))
    await flush()
    expand()
    expect(container.querySelector('#om-compactAfterTokens')).not.toBeNull()
    expect(container.querySelector('#om-compactAfterTokensRatio')).toBeNull()
  })

  it('shows only the ratio threshold in ratio mode', async () => {
    const scope = fakeScope({ user: { compactAfterTokensMode: 'ratio' } })
    mount(scope)
    await flush()
    expand()
    expect(container.querySelector('#om-compactAfterTokens')).toBeNull()
    expect(container.querySelector('#om-compactAfterTokensRatio')).not.toBeNull()
  })

  it('switches the displayed threshold with the mode draft and never writes the hidden one', async () => {
    const scope = fakeScope({})
    mount(scope)
    await flush()
    expand()

    // Stage a calibrated threshold, then flip the mode: the staged draft of
    // the now-hidden field must be dropped, and the save must write only the
    // mode.
    const input = container.querySelector<HTMLInputElement>('#om-compactAfterTokens')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, '5000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    selectValue(select('om-compactAfterTokensMode')!, 'ratio')
    expect(container.querySelector('#om-compactAfterTokens')).toBeNull()
    expect(container.querySelector('#om-compactAfterTokensRatio')).not.toBeNull()

    await save()
    const user = scope.getSnapshot().user as Record<string, unknown>
    expect(user.compactAfterTokensMode).toBe('ratio')
    expect(user.compactAfterTokens).toBeUndefined()
  })
})

describe('ObservationalMemoryCard model cascade', () => {
  it('keeps downstream dropdowns empty until the upstream pick is made', async () => {
    mount(fakeScope({}))
    await flush()
    expand()

    const provider = select('om-model.provider')!
    const model = select('om-model.id')!
    const effort = select('om-model.reasoningEffort')!
    expect(optionValues(provider)).toEqual(['', 'deepseek-official', 'openai'])
    expect(optionValues(model)).toEqual([])
    expect(model.disabled).toBe(true)
    expect(optionValues(effort)).toEqual([])
    expect(effort.disabled).toBe(true)

    selectValue(provider, 'deepseek-official')
    expect(optionValues(select('om-model.id')!)).toEqual(['', 'deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(optionValues(select('om-model.reasoningEffort')!)).toEqual([])

    selectValue(select('om-model.id')!, 'deepseek-v4-flash')
    expect(optionValues(select('om-model.reasoningEffort')!)).toEqual(['', 'off', 'high', 'max'])
  })

  it('clears downstream picks when the provider changes and saves the selected route', async () => {
    const scope = fakeScope({})
    mount(scope)
    await flush()
    expand()

    selectValue(select('om-model.provider')!, 'deepseek-official')
    selectValue(select('om-model.id')!, 'deepseek-v4-flash')
    selectValue(select('om-model.reasoningEffort')!, 'max')

    // Switching provider blanks model and effort.
    selectValue(select('om-model.provider')!, 'openai')
    expect(optionValues(select('om-model.id')!)).toEqual(['', 'gpt-5'])
    expect(select('om-model.id')!.value).toBe('')
    expect(select('om-model.reasoningEffort')!.value).toBe('')

    selectValue(select('om-model.id')!, 'gpt-5')
    await save()
    expect((scope.getSnapshot().user as Record<string, unknown>).model).toEqual({ provider: 'openai', id: 'gpt-5' })
  })

  it('clears the model override by picking the blank provider', async () => {
    const scope = fakeScope({ user: { model: { provider: 'openai', id: 'gpt-5' } } })
    mount(scope)
    await flush()
    expand()

    // A stored route outside the catalog stays selectable (and clearable).
    expect(optionValues(select('om-model.provider')!)).toContain('openai')
    selectValue(select('om-model.provider')!, '')
    await save()
    expect((scope.getSnapshot().user as Record<string, unknown>).model).toBeUndefined()
  })
})
