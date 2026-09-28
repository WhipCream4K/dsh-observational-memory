/**
 * Shared plugin runtime: effective config, the ledger store, per-session
 * in-flight guards, worker error memory, and worker-model resolution.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from './home.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { DebugLog } from './debug-log.ts'
import { LedgerStore } from './ledger/store.ts'
import type { WorkerModelTarget } from './workers/observer.ts'

export type WorkerPhase = 'observer' | 'reflector' | 'dropper'

/**
 * Where the runtime reads its config from: a fixed config (tests, and any
 * caller that owns the values) or a getter re-read on every access (the live
 * settings-backed entry).
 */
export type ConfigSource = Config | (() => Config)

/** Value comparison behind the live-config change detector. */
function sameConfig(a: Config, b: Config): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type ResolveResult =
  | {
      ok: true
      target: WorkerModelTarget
      contextWindow?: number
      /**
       * Whether the target came from the configured worker-model override
       * (false: session-routed model, agent options, or the global default —
       * including every suspension/resolution fallback). Only an override-path
       * success re-arms the override after failures.
       */
      viaOverride: boolean
    }
  | { ok: false; reason: string }

/** Deliberate-empty observer backoff state for one session. */
export type EmptyBackoff = {
  coverageSeq: number
  tokensAtEmpty: number
}

/** Storage root for ledgers and debug logs. */
export function storageRoot(config: ResolvedConfig): string {
  const configured = config.storageDir
  if (typeof configured === 'string' && configured.trim().length > 0) return configured
  return resolveDshHome('observational-memory')
}

export class OmRuntime {
  private _config: ResolvedConfig
  /** Last plain config the snapshot was resolved from (live-change detector). */
  private _raw: Config
  private readonly source: () => Config
  private _store: LedgerStore
  private readonly onError: (message: string) => void
  private debugLog: DebugLog | undefined
  private debugLogRoot: string | undefined

  /** Sessions with a consolidation pipeline currently running. */
  readonly consolidationInFlight = new Set<string>()
  /** Sessions with a proactive compaction currently in flight. */
  readonly compactInFlight = new Set<string>()
  /** Fork-ledger inheritance runs in flight, deduped per session. */
  private readonly inheritanceInFlight = new Map<string, Promise<void>>()

  readonly lastObserverError = new Map<string, string>()
  readonly lastReflectorError = new Map<string, string>()
  readonly lastDropperError = new Map<string, string>()
  readonly observerEmptyBackoff = new Map<string, EmptyBackoff>()
  /** Sessions already notified about model resolution failure (notify once). */
  readonly resolveFailureNotified = new Set<string>()
  /**
   * Consecutive worker-run failures per session — the suspension input for a
   * configured model override, and the streak reported by worker error debug
   * events. Always counted; reset by an override-path success (or any success
   * when no override is configured), never by a suspended-override fallback
   * success, so a tripped suspension is sticky within the current config epoch.
   */
  readonly workerConsecutiveFailures = new Map<string, number>()
  /** Sessions already notified that their model override is suspended (notify once per trip). */
  readonly overrideSuspensionNotified = new Set<string>()
  /** Consecutive deliberate-empty observer verdicts per session (warns from the 2nd on). */
  readonly observerConsecutiveEmpties = new Map<string, number>()

  constructor(config: ConfigSource, hooks: { onError: (message: string) => void }) {
    this.source = typeof config === 'function' ? config : () => config
    this._raw = this.source()
    this._config = resolveConfig(this._raw)
    this.onError = hooks.onError
    this._store = new LedgerStore(storageRoot(this._config), { onError: this.onError })
  }

  /**
   * Effective config: the live composition entry overlaid with user settings.
   *
   * The source is re-read on every access and the snapshot is re-resolved only
   * when its values changed, so a settings-page edit lands on the next read
   * without this plugin remounting. A real change starts a fresh worker-model
   * epoch (failure streaks belong to the previous config) and re-roots the
   * ledger store when `storageDir` moved.
   */
  get config(): ResolvedConfig {
    this.refresh()
    return this._config
  }

  get store(): LedgerStore {
    this.refresh()
    return this._store
  }

  /** Re-resolve the snapshot when the live source changed since the last read. */
  private refresh(): void {
    const next = this.source()
    // A constant source always hands back the same object: nothing to compare.
    if (next === this._raw || sameConfig(next, this._raw)) return
    const previousRoot = storageRoot(this._config)
    this._raw = next
    this._config = resolveConfig(next)
    this.workerConsecutiveFailures.clear()
    this.overrideSuspensionNotified.clear()
    const nextRoot = storageRoot(this._config)
    if (nextRoot !== previousRoot) {
      this._store = new LedgerStore(nextRoot, { onError: this.onError })
    }
  }

  /**
   * Record one worker-stage failure and bump the consecutive-failure streak.
   * The streak is always counted (it backs the error debug events and worker
   * notifications, so it stays meaningful without an override); it only FEEDS
   * override suspension while an override is configured. A later override
   * adoption passes through a config change, which starts a fresh config epoch
   * and clears any streak earned on the session model.
   */
  recordStageError(sessionId: string, phase: WorkerPhase, error: unknown): { message: string; consecutiveFailures: number } {
    const message = error instanceof Error ? error.message : String(error)
    if (phase === 'observer') this.lastObserverError.set(sessionId, message)
    if (phase === 'reflector') this.lastReflectorError.set(sessionId, message)
    if (phase === 'dropper') this.lastDropperError.set(sessionId, message)
    const consecutiveFailures = (this.workerConsecutiveFailures.get(sessionId) ?? 0) + 1
    this.workerConsecutiveFailures.set(sessionId, consecutiveFailures)
    return { message, consecutiveFailures }
  }

  /**
   * A worker run completed without a stream failure. An override-path success
   * proves the configured override healthy and re-arms it; with no override
   * configured, any success is the session model working and also resets the
   * streak. Only a fallback-path success while an override is suspended leaves
   * the streak (and the suspension) untouched.
   */
  noteWorkerSuccess(sessionId: string, viaOverride: boolean): void {
    if (!viaOverride && this.config.model !== undefined) return
    this.workerConsecutiveFailures.delete(sessionId)
    this.overrideSuspensionNotified.delete(sessionId)
  }

  /** One more consecutive deliberate-empty observer verdict; returns the streak. */
  noteObserverEmpty(sessionId: string): number {
    const streak = (this.observerConsecutiveEmpties.get(sessionId) ?? 0) + 1
    this.observerConsecutiveEmpties.set(sessionId, streak)
    return streak
  }

  /** Reset the empty-verdict streak after an observer run that recorded. */
  clearObserverEmpties(sessionId: string): void {
    this.observerConsecutiveEmpties.delete(sessionId)
  }

  /** Write one debug event when `debugLog` is enabled; otherwise a no-op. */
  debug(sessionId: string, event: string, data: Record<string, unknown> = {}): void {
    const config = this.config
    if (!config.debugLog) return
    const root = storageRoot(config)
    if (!this.debugLog || this.debugLogRoot !== root) {
      this.debugLog = new DebugLog(root, this.onError)
      this.debugLogRoot = root
    }
    this.debugLog.log(sessionId, event, data)
  }

  clearStageErrors(sessionId: string): void {
    this.lastObserverError.delete(sessionId)
    this.lastReflectorError.delete(sessionId)
    this.lastDropperError.delete(sessionId)
  }

  /**
   * Drop every per-session runtime entry when a session leaves the store, so
   * long-lived hosts do not accumulate one row per session id. The durable
   * ledger on disk is untouched.
   */
  clearSession(sessionId: string): void {
    this.clearStageErrors(sessionId)
    this.observerEmptyBackoff.delete(sessionId)
    this.resolveFailureNotified.delete(sessionId)
    this.workerConsecutiveFailures.delete(sessionId)
    this.overrideSuspensionNotified.delete(sessionId)
    this.observerConsecutiveEmpties.delete(sessionId)
    this.compactInFlight.delete(sessionId)
    this.consolidationInFlight.delete(sessionId)
  }

  /**
   * A fork child (rollback/branch) starts with an empty ledger while its
   * memory lives under the parent session's id, so the branch appears to
   * start over. On the child's first memory touch, copy the lineage's records
   * through the fork boundary into the child's ledger: the branch keeps the
   * memory of the path it shares with its source, while records covering only
   * the abandoned future (seqs beyond the boundary) stay behind. Watermarks
   * stay meaningful because a fork preserves the inherited events' seqs.
   *
   * The nearest ancestor with usable records wins; an ancestor with an empty
   * ledger (e.g. forked before it ever consolidated) defers to its own
   * parent, which keeps rollback-of-rollback chains working. Detached
   * ancestors still lend their on-disk ledger, but only an attached session
   * reveals its lineage, so the walk ends at the first detached ancestor.
   *
   * Idempotent: a child that already owns records never re-inherits, and
   * concurrent touches share one run. I/O failures degrade to "nothing
   * inherited" (the store reports and swallows them) — memory work must
   * never break the session pipeline.
   */
  async ensureInherited(ctx: Context, session: Session): Promise<void> {
    const parentId = session.header.parentSession
    if (parentId === undefined) return
    // The durable fork cut: inherited events occupy seqs 0..count-1, so the
    // last inherited seq is count-1 (a 0-count fork is an empty prefix).
    const inheritedCount: number = session.inheritedEventCount
    if (typeof inheritedCount !== 'number' || inheritedCount <= 0) return
    const sessionId: string = session.id
    const pending = this.inheritanceInFlight.get(sessionId)
    if (pending) return pending
    const task = this.inheritLineage(ctx, sessionId, parentId, inheritedCount - 1)
    this.inheritanceInFlight.set(sessionId, task)
    try {
      await task
    } finally {
      this.inheritanceInFlight.delete(sessionId)
    }
  }

  /** One inheritance pass: walk up the lineage to the nearest usable ledger. */
  private async inheritLineage(ctx: Context, sessionId: string, parentId: SessionId, boundary: number): Promise<void> {
    const own = await this._store.load(sessionId)
    if (own.length > 0) return
    const visited = new Set<string>([sessionId])
    let ancestorId: SessionId | undefined = parentId
    while (ancestorId !== undefined && !visited.has(ancestorId)) {
      visited.add(ancestorId)
      const entries = await this._store.load(ancestorId)
      const inherited = entries.filter((entry) =>
        entry.kind === 'visible-memory' ? entry.upToSeq <= boundary : entry.coversUpToSeq <= boundary)
      if (inherited.length > 0) {
        for (const entry of inherited) {
          await this._store.append(sessionId, entry)
        }
        this.debug(sessionId, 'ledger.inherited', { from: ancestorId, records: inherited.length, throughSeq: boundary })
        if (this.config.showWorkerNotifications) {
          ctx.logger.info(
            `[observational-memory] session inherited ${inherited.length} memory record(s) from ${ancestorId} (through seq ${boundary})`,
          )
        }
        return
      }
      // The ancestor's ledger has nothing within the boundary (possibly
      // nothing at all); its own fork parent may still hold usable records.
      ancestorId = ctx.sessions.get(ancestorId)?.header.parentSession
    }
  }

  /**
   * The session model's context window, for the ratio-mode compaction
   * threshold. Unlike {@link resolveModel} this never applies the configured
   * worker-model override: compaction guards the session's own context.
   * Resolution failure is not an error here — the ratio fallback covers it.
   */
  async sessionContextWindow(ctx: Context, session: Session, agent: Agent | undefined): Promise<number | undefined> {
    const routed = session.requestHeader()?.config
    const target =
      routed && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model }
        : agent && agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model }
          : defaultSelection(ctx)
    if (!target) return undefined
    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
      return info.context?.contextWindow
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the model memory workers call: the configured override when it
   * names a registered route, else the session's durably routed request
   * target, else the live agent's options, else the global default model
   * selection.
   */
  async resolveModel(ctx: Context, session: Session, agent: Agent | undefined): Promise<ResolveResult> {
    // One snapshot for the whole resolution: a settings edit landing mid-call
    // must not split the override decision across two config epochs.
    const config = this.config
    const configured = config.model
    const routed = session.requestHeader()?.config
    const fallback =
      routed && routed.provider.length > 0 && routed.model.length > 0
        ? { provider: routed.provider, model: routed.model, reasoningEffort: routed.reasoningEffort }
        : agent && agent.options.provider && agent.options.model
          ? { provider: agent.options.provider, model: agent.options.model, reasoningEffort: agent.options.reasoningEffort }
          : defaultSelection(ctx)

    // Suspension: once a configured override has failed
    // `modelFallbackAfterFailures` consecutive worker runs, it stops being
    // offered and the session/default model takes over (0 disables the
    // mechanism). Sticky within the config epoch: only an override-path
    // success, a config change, or a session reload re-arms it.
    const threshold = config.modelFallbackAfterFailures
    const suspended =
      configured !== undefined
      && threshold > 0
      && (this.workerConsecutiveFailures.get(session.id) ?? 0) >= threshold
    if (suspended && configured && !this.overrideSuspensionNotified.has(session.id)) {
      this.overrideSuspensionNotified.add(session.id)
      this.onError(
        `observational-memory: worker model ${configured.provider}/${configured.id} suspended for session ${session.id} `
        + `after ${threshold} consecutive failure(s); falling back to the session model`,
      )
    }

    const viaOverride = configured !== undefined && !suspended
    const target = viaOverride && configured
      ? { provider: configured.provider, model: configured.id, reasoningEffort: configured.reasoningEffort }
      : fallback
    if (!target) {
      return {
        ok: false,
        reason: 'no model available (session has no routed model and no observational-memory model is configured)',
      }
    }

    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model)
      return { ok: true, target, contextWindow: info.context?.contextWindow, viaOverride }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!viaOverride || !configured || !fallback) return { ok: false, reason: message }
      // A configured override that does not resolve falls back to the
      // session/default target rather than disabling memory work.
      this.onError(
        `observational-memory: configured model ${configured.provider}/${configured.id} is unavailable (${message}); falling back`,
      )
      try {
        const info = await ctx.llm.resolveModelInfo(fallback.provider, fallback.model)
        return { ok: true, target: fallback, contextWindow: info.context?.contextWindow, viaOverride: false }
      } catch (fallbackError) {
        return { ok: false, reason: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) }
      }
    }
  }
}

/** The deployment's default model selection, when the service is mounted. */
function defaultSelection(
  ctx: Context,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  try {
    const service = ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
      | undefined
    const selection = service?.currentSelection()
    if (selection && selection.provider.length > 0 && selection.model.length > 0) return selection
  } catch {
    // Treat a failing read as absent; resolution reports the final failure.
  }
  return undefined
}
