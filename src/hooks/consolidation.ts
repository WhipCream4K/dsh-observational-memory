/**
 * Consolidation trigger: runs the observer → reflector → dropper pipeline in
 * the background when a session's raw-token clocks are due. Triggered by the
 * persisted `turn/end` session event and by `agent/session-start` (a resumed
 * session may already carry an unobserved backlog).
 *
 * {@link runConsolidationNow} is the manual entry behind the Memory tab's
 * "run now" action: passive mode's proactive surface, bypassing the passive
 * switch and the token clocks on the user's explicit request.
 *
 * Observer work has priority within a run: the reflector and dropper stages
 * still execute after it, in order, exactly like pi-observational-memory's
 * single consolidation pipeline.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  buildObservationsDropped,
  buildObservationsRecorded,
  buildReflectionsRecorded,
  foldLedger,
  fullProjection,
  latestCoverageSeq,
  observationToSummaryLine,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionToSummaryLine,
  earlierSeq,
  eventsAfter,
  type Reflection,
} from '../ledger/index.ts'
import { resolveObserverChunkMaxTokens, resolveObservationsPoolTargetTokens } from '../config.ts'
import { serializeSourceAddressedEvents } from '../serialize.ts'
import type { OmRuntime, ResolveResult } from '../runtime.ts'
import { runDropper } from '../workers/dropper.ts'
import { runObserver } from '../workers/observer.ts'
import { runReflector } from '../workers/reflector.ts'
import { observationPoolMetrics } from '../workers/pool.ts'

type ResolvedModel = Extract<ResolveResult, { ok: true }>

/** Pipeline switches: `force` bypasses the token clocks (manual runs only). */
export interface ConsolidationOptions {
  force?: boolean
}

type Notify = (level: 'info' | 'warning', message: string) => void

function makeNotify(ctx: Context, runtime: OmRuntime): Notify {
  return (level, message) => {
    if (level === 'info' && !runtime.config.showWorkerNotifications) return
    const line = `[observational-memory] ${message}`
    if (level === 'info') ctx.logger.info(line)
    else ctx.logger.warn(line)
  }
}

/** Session ids the pipeline ignores: subagent children have no memory of their own. */
function isMemorySession(session: Session): boolean {
  return session.header.origin !== 'subagent'
}

export function registerConsolidationTrigger(ctx: Context, runtime: OmRuntime): void {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (!isMemorySession(session)) return
    launch(ctx, runtime, session)
  })
  // A session that becomes live (open, resume, clear, or post-compaction
  // re-entry) gets the same catch-up launch the turn/end trigger gives it.
  // DSH 0.1.7 renamed `agent/session-start` to `agent/created`.
  ctx.on('agent/created', ({ agent }) => {
    if (!isMemorySession(agent.session)) return undefined
    launch(ctx, runtime, agent.session)
    return undefined
  })
}

function launch(ctx: Context, runtime: OmRuntime, session: Session): void {
  void maybeLaunchConsolidation(ctx, runtime, session).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[observational-memory] consolidation failed: ${message}`)
  })
}

/** Exported for tests; the triggers above are the production callers. */
export async function maybeLaunchConsolidation(ctx: Context, runtime: OmRuntime, session: Session): Promise<void> {
  // Inheriting a fork parent's ledger is not a proactive trigger: passive
  // mode keeps it, so a rolled-back branch holds on to the memory it shares
  // with its source even with every background worker disabled.
  await runtime.ensureInherited(ctx, session)
  const config = runtime.config
  if (config.passive) return
  const sessionId: string = session.id
  if (runtime.consolidationInFlight.has(sessionId)) return
  // Claim the slot synchronously — before the first await — so concurrent
  // turn/end and session-start triggers cannot double-run the pipeline.
  runtime.consolidationInFlight.add(sessionId)
  try {
    const entries = await runtime.store.load(sessionId)
    const events = session.snapshotEvents()
    const observerDue = rawTokensSinceObservationCoverage(events, entries) >= config.observeAfterTokens
    const reflectorDue = rawTokensSinceReflectionCoverage(events, entries) >= config.reflectAfterTokens
    if (!observerDue && !reflectorDue) return

    runtime.clearStageErrors(sessionId)
    await runConsolidationPipeline(ctx, runtime, session)
  } finally {
    runtime.consolidationInFlight.delete(sessionId)
  }
}

/**
 * The manual consolidation entry behind the Memory tab's "run now" action —
 * passive mode's proactive surface. The user's explicit request bypasses the
 * passive switch and the token clocks (stages still no-op over an empty
 * backlog), while the per-session in-flight guard still applies.
 *
 * Returns false for subagent sessions (no memory of their own) and when a
 * run is already active for the session.
 */
export async function runConsolidationNow(ctx: Context, runtime: OmRuntime, session: Session): Promise<boolean> {
  if (session.header.origin === 'subagent') return false
  const sessionId: string = session.id
  if (runtime.consolidationInFlight.has(sessionId)) return false
  // Claim the slot synchronously — before the first await — so a double
  // click cannot double-run the pipeline.
  runtime.consolidationInFlight.add(sessionId)
  try {
    await runtime.ensureInherited(ctx, session)
    runtime.clearStageErrors(sessionId)
    await runConsolidationPipeline(ctx, runtime, session, { force: true })
    return true
  } finally {
    runtime.consolidationInFlight.delete(sessionId)
  }
}

/** Exported for tests; `maybeLaunchConsolidation` is the production caller. */
export async function runConsolidationPipeline(
  ctx: Context,
  runtime: OmRuntime,
  session: Session,
  options: ConsolidationOptions = {},
): Promise<void> {
  const notify = makeNotify(ctx, runtime)
  const sessionId: string = session.id
  let agent: Agent | undefined
  try {
    agent = ctx.agents.get(session.id)
  } catch {
    agent = undefined
  }

  let cached: ResolveResult | undefined
  const resolveModel = async (): Promise<ResolvedModel | undefined> => {
    cached ??= await runtime.resolveModel(ctx, session, agent)
    if (cached.ok) {
      runtime.resolveFailureNotified.delete(sessionId)
      return cached
    }
    runtime.debug(sessionId, 'model_unavailable', { reason: cached.reason })
    if (!runtime.resolveFailureNotified.has(sessionId)) {
      runtime.resolveFailureNotified.add(sessionId)
      notify('warning', `memory worker skipped — ${cached.reason}`)
    }
    return undefined
  }

  try {
    await runObserverStage(ctx, runtime, session, resolveModel, notify, options)
  } catch (error) {
    const { message, consecutiveFailures } = runtime.recordStageError(sessionId, 'observer', error)
    runtime.debug(sessionId, 'observer.error', { errorMessage: message, consecutiveFailures })
    notify('warning', `observer failed: ${message} (consecutive failures: ${consecutiveFailures})`)
    return
  }

  let reflectorResult: { reflections: Reflection[]; coverageSeq?: number }
  try {
    reflectorResult = await runReflectorStage(ctx, runtime, session, resolveModel, notify, options)
  } catch (error) {
    const { message, consecutiveFailures } = runtime.recordStageError(sessionId, 'reflector', error)
    runtime.debug(sessionId, 'reflector.error', { errorMessage: message, consecutiveFailures })
    notify('warning', `reflector failed: ${message} (consecutive failures: ${consecutiveFailures})`)
    return
  }

  try {
    await runDropperStage(ctx, runtime, session, resolveModel, notify, reflectorResult.reflections, reflectorResult.coverageSeq)
  } catch (error) {
    const { message, consecutiveFailures } = runtime.recordStageError(sessionId, 'dropper', error)
    runtime.debug(sessionId, 'dropper.error', { errorMessage: message, consecutiveFailures })
    notify('warning', `dropper failed: ${message} (consecutive failures: ${consecutiveFailures})`)
  }
}

async function runObserverStage(
  ctx: Context,
  runtime: OmRuntime,
  session: Session,
  resolveModel: () => Promise<ResolvedModel | undefined>,
  notify: Notify,
  options: ConsolidationOptions = {},
): Promise<void> {
  const sessionId: string = session.id
  const config = runtime.config
  const entries = await runtime.store.load(sessionId)
  const events = session.snapshotEvents()
  const tokens = rawTokensSinceObservationCoverage(events, entries)
  // A manual run ignores the clock; an empty backlog still no-ops below.
  if (!options.force && tokens < config.observeAfterTokens) return

  const coverageSeq = latestCoverageSeq(entries, 'observations-recorded')

  // Deliberate-empty backoff: an intentional "nothing to record" verdict must
  // not re-fire every turn over the same span; retry after another
  // observeAfterTokens worth of source text, and drop the backoff as soon as
  // coverage advances. A manual run is the user's explicit retry, so it
  // ignores the backoff.
  const backoff = runtime.observerEmptyBackoff.get(sessionId)
  if (!options.force && backoff) {
    if (coverageSeq !== backoff.coverageSeq || tokens >= backoff.tokensAtEmpty + config.observeAfterTokens) {
      runtime.observerEmptyBackoff.delete(sessionId)
    } else {
      runtime.debug(sessionId, 'observer.empty_backoff', { tokens })
      return
    }
  }

  const resolved = await resolveModel()
  if (!resolved) return

  // The full post-watermark range (not just source events): the serializer
  // skips non-source content but needs tool/call events for result labels.
  const backlog = eventsAfter(events, coverageSeq)
  const maxChunkTokens = resolveObserverChunkMaxTokens(config, resolved.contextWindow)
  const { text: chunk, sourceEventSeqs, estimatedTokens: chunkTokens } = serializeSourceAddressedEvents(backlog, {
    maxTokens: maxChunkTokens,
  })
  if (!chunk.trim() || sourceEventSeqs.length === 0) return
  const coversUpToSeq = sourceEventSeqs[sourceEventSeqs.length - 1]

  const memory = fullProjection(entries)
  const priorReflections = memory.reflections.map(reflectionToSummaryLine)
  const priorObservations = memory.observations.map(observationToSummaryLine)

  notify('info', `observer running on ~${chunkTokens.toLocaleString()}-token chunk via ${resolved.target.provider}/${resolved.target.model}`)
  runtime.debug(sessionId, 'observer.start', {
    tokens,
    chunkTokens,
    coversUpToSeq,
    sourceEventSeqs,
    provider: resolved.target.provider,
    model: resolved.target.model,
    viaOverride: resolved.viaOverride,
  })

  const observations = await runObserver(ctx, {
    target: resolved.target,
    priorReflections,
    priorObservations,
    chunk,
    allowedSourceEventSeqs: sourceEventSeqs,
    maxTurns: config.agentMaxTurns,
  })
  // The model call itself settled: an override-path success re-arms a
  // suspended override, whatever the verdict.
  runtime.noteWorkerSuccess(sessionId, resolved.viaOverride)

  if (!observations || observations.length === 0) {
    runtime.observerEmptyBackoff.set(sessionId, { coverageSeq, tokensAtEmpty: tokens })
    const streak = runtime.noteObserverEmpty(sessionId)
    runtime.debug(sessionId, 'observer.empty', { coversUpToSeq, consecutiveEmpties: streak })
    // A first empty verdict can be legitimate ("nothing worth recording");
    // consecutive empties over a growing backlog usually mean the worker
    // model is not following the record_observations tool contract — warn.
    if (streak >= 2) {
      notify('warning', `observer returned no observations in ${streak} consecutive runs; the worker model may not be calling the record_observations tool`)
    } else {
      notify('info', 'observer found nothing new in this chunk (coverage unchanged; will retry later)')
    }
    return
  }
  runtime.observerEmptyBackoff.delete(sessionId)
  runtime.clearObserverEmpties(sessionId)

  const record = buildObservationsRecorded(observations, coversUpToSeq)
  if (!record) return
  await runtime.store.append(sessionId, record)
  runtime.debug(sessionId, 'observer.appended', { count: observations.length, coversUpToSeq })
  notify('info', `${observations.length} observation${observations.length === 1 ? '' : 's'} recorded`)
}

async function runReflectorStage(
  ctx: Context,
  runtime: OmRuntime,
  session: Session,
  resolveModel: () => Promise<ResolvedModel | undefined>,
  notify: Notify,
  options: ConsolidationOptions = {},
): Promise<{ reflections: Reflection[]; coverageSeq?: number }> {
  const sessionId: string = session.id
  const config = runtime.config
  const entries = await runtime.store.load(sessionId)
  const events = session.snapshotEvents()
  const reflectionTokens = rawTokensSinceReflectionCoverage(events, entries)
  // A forced run bypasses the threshold but not emptiness: with no new
  // source text since the last reflection, re-reflecting the unchanged pool
  // would spend a model call on the exact input it already crystallized.
  const reflectorDue = options.force ? reflectionTokens > 0 : reflectionTokens >= config.reflectAfterTokens
  if (!reflectorDue) return { reflections: [] }

  const observationCoverageSeq = latestCoverageSeq(entries, 'observations-recorded')
  if (observationCoverageSeq < 0) return { reflections: [] }
  // A manual run reflects on demand, but with an empty observation pool
  // there is nothing to crystallize; skip the model call entirely.
  if (options.force && foldLedger(entries).activeObservations.length === 0) return { reflections: [] }

  const resolved = await resolveModel()
  if (!resolved) return { reflections: [] }

  notify('info', `reflector running (~${reflectionTokens.toLocaleString()} tokens)`)
  const folded = foldLedger(entries)
  const reflections = await runReflector(ctx, {
    target: resolved.target,
    reflections: folded.reflections,
    observations: folded.activeObservations,
    maxTurns: config.agentMaxTurns,
  })
  runtime.noteWorkerSuccess(sessionId, resolved.viaOverride)
  if (!reflections || reflections.length === 0) return { reflections: [] }

  const record = buildReflectionsRecorded(reflections, observationCoverageSeq)
  if (!record) return { reflections: [] }
  await runtime.store.append(sessionId, record)
  runtime.debug(sessionId, 'reflector.appended', { count: reflections.length, coversUpToSeq: record.coversUpToSeq })
  notify('info', `${reflections.length} reflection${reflections.length === 1 ? '' : 's'} crystallized`)
  return { reflections, coverageSeq: record.coversUpToSeq }
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
  const seen = new Set(existing.map((reflection) => reflection.id))
  const merged = [...existing]
  for (const reflection of additional) {
    if (seen.has(reflection.id)) continue
    seen.add(reflection.id)
    merged.push(reflection)
  }
  return merged
}

async function runDropperStage(
  ctx: Context,
  runtime: OmRuntime,
  session: Session,
  resolveModel: () => Promise<ResolvedModel | undefined>,
  notify: Notify,
  sameRunReflections: Reflection[],
  sameRunReflectionCoverageSeq: number | undefined,
): Promise<void> {
  if (sameRunReflectionCoverageSeq === undefined || sameRunReflections.length === 0) {
    return
  }

  const sessionId: string = session.id
  const entries = await runtime.store.load(sessionId)
  const observationCoverageSeq = latestCoverageSeq(entries, 'observations-recorded')
  if (observationCoverageSeq < 0) return

  const config = runtime.config
  const targetTokens = resolveObservationsPoolTargetTokens(config)
  const folded = foldLedger(entries)
  const metrics = observationPoolMetrics(folded.activeObservations, targetTokens)
  if (!metrics.ready) {
    runtime.debug(sessionId, 'dropper.not_ready', {
      observationTokens: metrics.observationTokens,
      targetTokens: metrics.targetTokens,
    })
    return
  }

  notify(
    'info',
    `dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens`,
  )
  const resolved = await resolveModel()
  if (!resolved) return

  const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections)
  const droppedIds = await runDropper(ctx, {
    target: resolved.target,
    reflections: reflectionsForDropper,
    observations: folded.activeObservations,
    targetTokens,
    maxTurns: config.agentMaxTurns,
  })
  runtime.noteWorkerSuccess(sessionId, resolved.viaOverride)

  const coversUpToSeq = earlierSeq(observationCoverageSeq, sameRunReflectionCoverageSeq)
  const record = coversUpToSeq !== undefined && droppedIds ? buildObservationsDropped(droppedIds, coversUpToSeq) : undefined
  runtime.debug(sessionId, 'dropper.append', { droppedIdsCount: droppedIds?.length ?? 0, coversUpToSeq })
  if (record) {
    await runtime.store.append(sessionId, record)
    notify('info', `${record.observationIds.length} observation${record.observationIds.length === 1 ? '' : 's'} dropped from active memory`)
  }
}
