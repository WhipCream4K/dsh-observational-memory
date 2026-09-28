/**
 * The Observational Memory card's staged form over the `observational-memory`
 * settings namespace.
 *
 * A card stages what the user types and writes it only when they save: each
 * settings write is a durable, revision-fenced document mutation, so controls
 * never commit on blur. A field shows its effective value (user layer over
 * composition layer over schema default); key presence in the user layer — not
 * a value comparison — is what marks it overridden.
 *
 * Self-contained by design: the client bundle-purity gate forbids importing
 * the shipped cards' form machinery, so this controller owns its own staging
 * and revision fencing through the bound settings scope.
 */

/**
 * One path-addressed edit inside the settings section. DSH 0.1.7's form
 * writes are ordered atomic mutations over paths, so a dotted field name has
 * to travel as path segments (`model.provider` → `['model', 'provider']`)
 * rather than as one literal key.
 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** The slice of the settings form contract this form consumes. */
export interface SettingsScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: unknown
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  /** Queue one atomic mutation; resolves whether the Host accepted it. */
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
}

/** Minimal snapshot store the slot renderer binds as a selector hook. */
export interface SnapshotStoreLike<T> {
  getSnapshot(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
}

/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelCatalogEffort {
  id: string
  name: string
  description?: string
}

/** One model inside its provider group of the Host model catalog. */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: readonly ModelCatalogEffort[]; defaultEffort?: string }
}

/** One provider and its model catalog. */
export interface ModelCatalogGroup {
  id: string
  name: string
  models: readonly ModelCatalogModel[]
}

/** The slice of the Connection RPC caller the model-catalog fetch consumes. */
export interface CatalogRpcLike {
  call(
    channel: '/api',
    endpoint: string,
    payload: unknown,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } }
  >
}

/** Project the wire value of `session/modelCatalog` into catalog groups. */
export function parseModelCatalog(value: unknown): ModelCatalogGroup[] {
  if (!value || typeof value !== 'object') return []
  const groups = (value as { groups?: unknown }).groups
  if (!Array.isArray(groups)) return []
  const parsed: ModelCatalogGroup[] = []
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue
    const { id, name, models } = group as { id?: unknown; name?: unknown; models?: unknown }
    if (typeof id !== 'string' || id === '') continue
    const parsedModels: ModelCatalogModel[] = []
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== 'object') continue
        const entry = model as { id?: unknown; name?: unknown; reasoning?: unknown }
        if (typeof entry.id !== 'string' || entry.id === '') continue
        let reasoning: ModelCatalogModel['reasoning']
        if (entry.reasoning && typeof entry.reasoning === 'object') {
          const efforts = (entry.reasoning as { efforts?: unknown }).efforts
          const defaultEffort = (entry.reasoning as { defaultEffort?: unknown }).defaultEffort
          if (Array.isArray(efforts)) {
            reasoning = {
              efforts: efforts.flatMap((effort) => {
                if (!effort || typeof effort !== 'object') return []
                const e = effort as { id?: unknown; name?: unknown }
                return typeof e.id === 'string' && e.id !== ''
                  ? [{ id: e.id, name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id }]
                  : []
              }),
              ...(typeof defaultEffort === 'string' ? { defaultEffort } : {}),
            }
          }
        }
        parsedModels.push({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
          ...(reasoning !== undefined ? { reasoning } : {}),
        })
      }
    }
    parsed.push({ id, name: typeof name === 'string' && name !== '' ? name : id, models: parsedModels })
  }
  return parsed
}

/** A tiny useSyncExternalStore-shaped snapshot store (sync flush). */
function createStore<T>(init: T): SnapshotStoreLike<T> {
  let current = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    set(next: T) {
      current = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type FieldKind = 'number' | 'text' | 'boolean' | 'choice'

export interface FieldDef {
  /** Top-level settings field, or a dotted `model.*` sub-field. */
  key: string
  kind: FieldKind
  /** Minimum accepted value for numeric fields. */
  min?: number
  /** Maximum accepted value for numeric fields. */
  max?: number
  /** Treat min/max as exclusive bounds (e.g. a ratio strictly inside (0, 1)). */
  exclusive?: boolean
  /** Accepted values for choice fields. */
  options?: readonly string[]
}

/** One field as the card renders it. */
export interface FieldState {
  /** Draft text (`'true'/'false'` for booleans). */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, blocking the save. */
  invalid: boolean
}

/** Card-level state. */
export interface CardShellState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export interface OmCardState extends CardShellState {
  fields: Record<string, FieldState>
  /** Host model-catalog request state behind the model dropdowns. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Provider groups of the loaded model catalog; empty until ready. */
  catalog: readonly ModelCatalogGroup[]
}

/** The actions the card's slot entry injects. */
export interface OmCardActions {
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  /** Reload the Host model catalog behind the model dropdowns. */
  retryCatalog(): void
}

export interface OmCardFace extends OmCardActions {
  hooks: {
    omCard: SnapshotStoreLike<OmCardState>
  }
}

type StagedEdit = { text: string; clear: boolean }

const MODEL_KEYS = ['model.provider', 'model.id', 'model.reasoningEffort'] as const

/** Every field the card edits, in display order. */
export const CARD_FIELDS: FieldDef[] = [
  { key: 'observeAfterTokens', kind: 'number', min: 1 },
  { key: 'reflectAfterTokens', kind: 'number', min: 1 },
  { key: 'observerChunkMaxTokens', kind: 'number', min: 256 },
  { key: 'compactAfterTokens', kind: 'number', min: 0 },
  { key: 'compactAfterTokensMode', kind: 'choice', options: ['calibrated', 'ratio'] },
  { key: 'compactAfterTokensRatio', kind: 'number', min: 0, max: 1, exclusive: true },
  { key: 'observationsPoolMaxTokens', kind: 'number', min: 1 },
  { key: 'observationsPoolTargetTokens', kind: 'number', min: 1 },
  { key: 'agentMaxTurns', kind: 'number', min: 1 },
  { key: 'passive', kind: 'boolean' },
  { key: 'showWorkerNotifications', kind: 'boolean' },
  { key: 'debugLog', kind: 'boolean' },
  { key: 'storageDir', kind: 'text' },
  { key: 'model.provider', kind: 'text' },
  { key: 'model.id', kind: 'text' },
  { key: 'model.reasoningEffort', kind: 'text' },
  { key: 'modelFallbackAfterFailures', kind: 'number', min: 0 },
]

function readPath(source: unknown, key: string): unknown {
  if (!source || typeof source !== 'object') return undefined
  const parts = key.split('.')
  let current: unknown = source
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function hasPath(source: unknown, key: string): boolean {
  if (!source || typeof source !== 'object') return false
  const parts = key.split('.')
  let current: unknown = source
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false
    current = (current as Record<string, unknown>)[part]
  }
  return true
}

export class OmCardController {
  private readonly specs = new Map<string, FieldDef>()
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private catalogStatus: OmCardState['catalogStatus'] = 'idle'
  private catalog: readonly ModelCatalogGroup[] = []
  /** Bumps on every issued catalog request so a late response never wins. */
  private catalogGeneration = 0
  private readonly store: SnapshotStoreLike<OmCardState>
  /** Detaches this controller from the settings form it derives from. */
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsScopeLike,
    fields: FieldDef[],
    private readonly rpc?: CatalogRpcLike,
  ) {
    for (const field of fields) this.specs.set(field.key, field)
    this.store = createStore(this.projection())
    this.unsubscribe = scope.subscribe(() => this.publish())
    // The model dropdowns need the Host catalog; fetch it once up front so
    // expanding the card never waits on the wire.
    if (rpc !== undefined) void this.loadCatalog()
  }

  /** Drop the form subscription; the shared form outlives this controller. */
  dispose(): void {
    this.unsubscribe()
  }

  inject(): OmCardFace {
    return {
      hooks: { omCard: this.store },
      edit: (field, text) => this.editField(field, text),
      resetField: (field) => this.stage(field, { text: this.format(this.readBase(field), field), clear: true }),
      save: () => void this.save(),
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
      retryCatalog: () => void this.loadCatalog(),
    }
  }

  /**
   * Stage one edit plus the cascade it implies:
   *
   * - Switching the compaction-threshold mode drops the staged draft of the
   *   threshold field the new mode hides, so a save can never write a
   *   parameter the mode makes inert.
   * - Changing the model provider blanks the staged model ID and reasoning
   *   effort (a route under the previous provider is meaningless under the
   *   new one); changing the model blanks the effort.
   */
  private editField(field: string, text: string): void {
    this.staged.set(field, { text, clear: false })
    if (field === 'compactAfterTokensMode') {
      this.staged.delete(text === 'ratio' ? 'compactAfterTokens' : 'compactAfterTokensRatio')
    }
    if (field === 'model.provider') {
      this.staged.set('model.id', { text: '', clear: false })
      this.staged.set('model.reasoningEffort', { text: '', clear: false })
    }
    if (field === 'model.id') {
      this.staged.set('model.reasoningEffort', { text: '', clear: false })
    }
    this.failed = false
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    if (this.rpc === undefined || this.catalogStatus === 'loading') return
    const generation = ++this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()
    const result = await this.rpc.call('/api', 'session/modelCatalog', { args: {} })
    if (generation !== this.catalogGeneration) return
    if (result.ok) {
      this.catalog = parseModelCatalog(result.value)
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  /**
   * The threshold field the current mode draft hides. A save must not write
   * it: only the parameter the selected mode shows is effective.
   */
  private hiddenThresholdField(): string {
    const stagedMode = this.staged.get('compactAfterTokensMode')
    const mode = stagedMode === undefined
      ? this.format(this.readValue('compactAfterTokensMode'), 'compactAfterTokensMode')
      : stagedMode.clear
        // A staged reset makes the composition-layer mode effective on save.
        ? this.format(this.readBase('compactAfterTokensMode'), 'compactAfterTokensMode')
        : stagedMode.text.trim()
    return mode === 'ratio' ? 'compactAfterTokens' : 'compactAfterTokensRatio'
  }

  private projection(): OmCardState {
    const snapshot = this.scope.getSnapshot()
    const fields: Record<string, FieldState> = {}
    for (const key of this.specs.keys()) fields[key] = this.fieldState(key)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid: [...this.specs.keys()].some((key) => this.fieldState(key).invalid),
      saving: this.saving,
      failed: this.failed,
      fields,
      catalogStatus: this.catalogStatus,
      catalog: this.catalog,
    }
  }

  private fieldState(key: string): FieldState {
    const staged = this.staged.get(key)
    if (staged === undefined) {
      return { text: this.format(this.readValue(key), key), overridden: hasPath(this.scope.getSnapshot().user, key), invalid: false }
    }
    if (staged.clear) {
      return { text: staged.text, overridden: false, invalid: false }
    }
    return { text: staged.text, overridden: this.writeKind(key, staged.text) === 'set', invalid: this.writeKind(key, staged.text) === undefined }
  }

  private format(value: unknown, key: string): string {
    const spec = this.specs.get(key)
    if (spec?.kind === 'boolean') return value === true ? 'true' : 'false'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return value
    return ''
  }

  /** The write a draft performs: 'set', 'clear', or undefined when invalid. */
  private writeKind(key: string, text: string): 'set' | 'clear' | undefined {
    const spec = this.specs.get(key)
    const trimmed = text.trim()
    if (spec?.kind === 'boolean') {
      if (trimmed === 'true' || trimmed === 'false') return 'set'
      return undefined
    }
    if (trimmed === '') return 'clear'
    if (spec?.kind === 'number') {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return undefined
      if (spec.min !== undefined && (spec.exclusive ? parsed <= spec.min : parsed < spec.min)) return undefined
      if (spec.max !== undefined && (spec.exclusive ? parsed >= spec.max : parsed > spec.max)) return undefined
      return 'set'
    }
    if (spec?.kind === 'choice') {
      return spec.options?.includes(trimmed) === true ? 'set' : undefined
    }
    return 'set'
  }

  private stage(key: string, edit: StagedEdit): void {
    // Staging an unchanged-at-clear value is still staged: the reset badge
    // previews the save rather than reporting stored state.
    this.staged.set(key, edit)
    this.failed = false
    this.publish()
  }

  private readValue(key: string): unknown {
    return readPath(this.scope.getSnapshot().value, key)
  }

  private readBase(key: string): unknown {
    return readPath(this.scope.getSnapshot().base, key)
  }

  private publish(): void {
    const next = this.projection()
    this.store.set(next)
    for (const listener of this.listeners) listener()
  }

  /** Resolve the model object a save would write, or 'clear', or undefined when invalid. */
  private plannedModel(): { provider: string; id: string; reasoningEffort?: string } | 'clear' | undefined {
    const read = (key: string): string => {
      const staged = this.staged.get(key)
      if (staged) return staged.clear ? '' : staged.text.trim()
      return this.format(this.readValue(key), key).trim()
    }
    const provider = read('model.provider')
    const id = read('model.id')
    const reasoningEffort = read('model.reasoningEffort')
    if (provider === '' && id === '') return 'clear'
    if (provider === '' || id === '') return undefined
    return reasoningEffort === '' ? { provider, id } : { provider, id, reasoningEffort }
  }

  private async save(): Promise<void> {
    if (this.saving) return
    const snapshot = this.scope.getSnapshot()
    if (!snapshot.writable) return

    // Plan writes; any invalid draft blocks the whole save instead of being dropped.
    const writes: { field: string; value: unknown }[] = []
    const clears: string[] = []
    const hiddenThreshold = this.hiddenThresholdField()
    for (const [key, staged] of this.staged) {
      if (MODEL_KEYS.includes(key as (typeof MODEL_KEYS)[number])) continue
      // Only the threshold parameter the selected mode shows is effective;
      // a draft of the hidden one is never written.
      if (key === hiddenThreshold) continue
      if (staged.clear) {
        if (hasPath(snapshot.user, key)) clears.push(key)
        continue
      }
      const trimmed = staged.text.trim()
      if (trimmed === this.format(this.readValue(key), key).trim()) continue
      const kind = this.writeKind(key, staged.text)
      if (kind === undefined) return
      if (kind === 'clear') clears.push(key)
      else {
        const spec = this.specs.get(key)
        writes.push({ field: key, value: spec?.kind === 'boolean' ? trimmed === 'true' : spec?.kind === 'number' ? Number(trimmed) : trimmed })
      }
    }

    const modelTouched = MODEL_KEYS.some((key) => this.staged.has(key))
    if (modelTouched) {
      const model = this.plannedModel()
      if (model === undefined) return
      if (model === 'clear') {
        if (hasPath(snapshot.user, 'model')) clears.push('model')
      } else {
        writes.push({ field: 'model', value: model })
      }
    }

    if (writes.length === 0 && clears.length === 0) return

    // One ordered mutation: clears first (a cleared field re-inherits the
    // composition layer), then the writes, all under one revision fence.
    const ops: SettingsPathOp[] = [
      ...clears.map((key): SettingsPathOp => ({ op: 'unset', path: key.split('.') })),
      ...writes.map((write): SettingsPathOp => ({ op: 'set', path: write.field.split('.'), value: write.value })),
    ]

    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      await this.scope.mutate(ops)
      // The Host is the only authority on acceptance: re-read the user layer.
      const user = this.scope.getSnapshot().user
      for (const key of clears) {
        if (hasPath(user, key)) landed = false
      }
      for (const write of writes) {
        const stored = readPath(user, write.field)
        if (JSON.stringify(stored) !== JSON.stringify(write.value)) landed = false
      }
    } catch {
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }
}
