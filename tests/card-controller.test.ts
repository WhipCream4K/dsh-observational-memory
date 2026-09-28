import { describe, expect, it } from 'vitest'
import {
  CARD_FIELDS,
  OmCardController,
  parseModelCatalog,
  type CatalogRpcLike,
  type SettingsScopeLike,
} from '../src/client/controller.ts'

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

/** In-memory settings scope mirroring the client contract's semantics. */
function fakeScope(initial: { value?: Record<string, unknown>; user?: Record<string, unknown>; base?: Record<string, unknown> }) {
  let user: Record<string, unknown> = { ...(initial.user ?? {}) }
  const listeners = new Set<() => void>()
  const scope: SettingsScopeLike = {
    getSnapshot: () => ({
      status: 'ready',
      // Resolved value: schema defaults under the user layer (key presence).
      value: { observeAfterTokens: 10_000, showWorkerNotifications: true, passive: false, ...(initial.value ?? {}), ...user },
      base: initial.base ?? {},
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

function makeController(scope: SettingsScopeLike) {
  const controller = new OmCardController(scope, CARD_FIELDS)
  const face = controller.inject()
  return { controller, face, state: () => face.hooks.omCard.getSnapshot() }
}

describe('OmCardController', () => {
  it('stages edits and reports dirtiness without writing', async () => {
    const { face, state } = makeController(fakeScope({}))
    expect(state().dirty).toBe(false)
    face.edit('observeAfterTokens', '5000')
    expect(state().dirty).toBe(true)
    expect(state().fields.observeAfterTokens.text).toBe('5000')
    expect(state().fields.observeAfterTokens.overridden).toBe(true)
  })

  it('marks invalid numeric drafts and blocks the save', async () => {
    const { face, state } = makeController(fakeScope({}))
    face.edit('observeAfterTokens', 'abc')
    expect(state().fields.observeAfterTokens.invalid).toBe(true)
    expect(state().invalid).toBe(true)
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state().dirty).toBe(true) // still staged — nothing was written
  })

  it('writes staged values on save and clears staging after acceptance', async () => {
    const scope = fakeScope({})
    const { face, state } = makeController(scope)
    face.edit('observeAfterTokens', '5000')
    face.edit('passive', 'true')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state().dirty).toBe(false)
    expect(state().failed).toBe(false)
    expect(scope.getSnapshot().user as Record<string, unknown>).toMatchObject({ observeAfterTokens: 5000, passive: true })
  })

  it('writes the model override as one object and clears it when blanked', async () => {
    const scope = fakeScope({})
    const { face, state } = makeController(scope)
    face.edit('model.provider', 'openrouter')
    face.edit('model.id', 'google/gemma-4-31b-it')
    face.edit('model.reasoningEffort', 'low')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((scope.getSnapshot().user as Record<string, unknown>).model).toEqual({
      provider: 'openrouter',
      id: 'google/gemma-4-31b-it',
      reasoningEffort: 'low',
    })

    face.edit('model.provider', '')
    face.edit('model.id', '')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((scope.getSnapshot().user as Record<string, unknown>).model).toBeUndefined()
  })

  it('reset stages a clear that removes the user-layer override', async () => {
    const scope = fakeScope({ user: { observeAfterTokens: 5000 } })
    const { face, state } = makeController(scope)
    expect(state().fields.observeAfterTokens.text).toBe('5000')
    expect(state().fields.observeAfterTokens.overridden).toBe(true)
    face.resetField('observeAfterTokens')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((scope.getSnapshot().user as Record<string, unknown>).observeAfterTokens).toBeUndefined()
    // Effective value falls back to the resolved default.
    expect(state().fields.observeAfterTokens.text).toBe('10000')
  })

  it('discard drops staged edits', () => {
    const { face, state } = makeController(fakeScope({}))
    face.edit('observeAfterTokens', '5000')
    face.discard()
    expect(state().dirty).toBe(false)
    expect(state().fields.observeAfterTokens.text).toBe('10000')
  })

  it('drops the staged draft of the threshold field a mode switch hides', async () => {
    const scope = fakeScope({ value: { compactAfterTokensMode: 'calibrated' } })
    const { face, state } = makeController(scope)
    face.edit('compactAfterTokens', '5000')
    expect(state().dirty).toBe(true)
    face.edit('compactAfterTokensMode', 'ratio')
    // The calibrated draft is gone; only the mode edit remains staged.
    expect(state().fields.compactAfterTokens.text).toBe('')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const user = scope.getSnapshot().user as Record<string, unknown>
    expect(user.compactAfterTokensMode).toBe('ratio')
    expect(user.compactAfterTokens).toBeUndefined()
  })

  it('never writes a staged draft of the threshold field the current mode hides', async () => {
    // Calibrated mode is in effect; a compactAfterTokensRatio draft staged
    // against it (e.g. pasted state) must not be written.
    const scope = fakeScope({ value: { compactAfterTokensMode: 'calibrated' } })
    const { face, state } = makeController(scope)
    face.edit('compactAfterTokensRatio', '0.5')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((scope.getSnapshot().user as Record<string, unknown>).compactAfterTokensRatio).toBeUndefined()
  })

  it('blanks the downstream model drafts when the provider changes', () => {
    const { face, state } = makeController(fakeScope({}))
    face.edit('model.provider', 'openai')
    face.edit('model.id', 'gpt-5')
    face.edit('model.reasoningEffort', 'high')
    face.edit('model.provider', 'deepseek-official')
    expect(state().fields['model.provider'].text).toBe('deepseek-official')
    expect(state().fields['model.id'].text).toBe('')
    expect(state().fields['model.reasoningEffort'].text).toBe('')
  })

  it('blanks the reasoning-effort draft when the model changes', () => {
    const { face, state } = makeController(fakeScope({}))
    face.edit('model.provider', 'deepseek-official')
    face.edit('model.id', 'deepseek-v4-flash')
    face.edit('model.reasoningEffort', 'max')
    face.edit('model.id', 'deepseek-v4-pro')
    expect(state().fields['model.reasoningEffort'].text).toBe('')
  })

  it('clears the model override when the provider is blanked', async () => {
    const scope = fakeScope({ user: { model: { provider: 'openai', id: 'gpt-5', reasoningEffort: 'high' } } })
    const { face, state } = makeController(scope)
    expect(state().fields['model.provider'].text).toBe('openai')
    face.edit('model.provider', '')
    expect(state().fields['model.id'].text).toBe('')
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((scope.getSnapshot().user as Record<string, unknown>).model).toBeUndefined()
  })
})

const CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek-official'],
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

function fakeCatalogRpc(result: { ok: boolean }): CatalogRpcLike & { calls: number } {
  const rpc = {
    calls: 0,
    call: (() => {
      rpc.calls += 1
      return Promise.resolve(
        result.ok
          ? { ok: true as const, value: CATALOG }
          : { ok: false as const, error: { code: 'unavailable', message: 'boom' } },
      )
    }) as CatalogRpcLike['call'],
  }
  return rpc
}

describe('OmCardController model catalog', () => {
  it('loads the catalog through session/modelCatalog and exposes the groups', async () => {
    const rpc = fakeCatalogRpc({ ok: true })
    const { face, state } = makeControllerWithRpc(fakeScope({}), rpc)
    expect(state().catalogStatus).toBe('loading')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rpc.calls).toBe(1)
    expect(state().catalogStatus).toBe('ready')
    expect(state().catalog.map((group) => group.id)).toEqual(['deepseek-official', 'openai'])
    const deepseek = state().catalog[0]
    expect(deepseek.models.map((model) => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(deepseek.models[0].reasoning?.efforts.map((effort) => effort.id)).toEqual(['off', 'high', 'max'])
    expect(face.hooks.omCard.getSnapshot().catalogStatus).toBe('ready')
  })

  it('reports an error and recovers on retry', async () => {
    const rpc = fakeCatalogRpc({ ok: false })
    const { face, state } = makeControllerWithRpc(fakeScope({}), rpc)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state().catalogStatus).toBe('error')
    face.retryCatalog()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(rpc.calls).toBe(2)
    expect(state().catalogStatus).toBe('error')
  })
})

function makeControllerWithRpc(scope: SettingsScopeLike, rpc: CatalogRpcLike) {
  const controller = new OmCardController(scope, CARD_FIELDS, rpc)
  const face = controller.inject()
  return { controller, face, state: () => face.hooks.omCard.getSnapshot() }
}

describe('parseModelCatalog', () => {
  it('drops malformed entries and fills display-name fallbacks', () => {
    const parsed = parseModelCatalog({
      groups: [
        null,
        { id: '', name: 'x', models: [] },
        {
          id: 'p1',
          models: [
            'nope',
            { id: 'm1' },
            { id: 'm2', name: '', reasoning: { efforts: [{ id: 'low' }, { name: 'x' }, null] } },
          ],
        },
      ],
    })
    expect(parsed).toEqual([
      {
        id: 'p1',
        name: 'p1',
        models: [
          { id: 'm1', name: 'm1' },
          { id: 'm2', name: 'm2', reasoning: { efforts: [{ id: 'low', name: 'low' }] } },
        ],
      },
    ])
  })

  it('returns an empty catalog for non-catalog values', () => {
    expect(parseModelCatalog(undefined)).toEqual([])
    expect(parseModelCatalog({})).toEqual([])
    expect(parseModelCatalog({ groups: 'nope' })).toEqual([])
  })
})
