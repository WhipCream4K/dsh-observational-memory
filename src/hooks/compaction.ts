/**
 * Compaction integration: when DSH's compaction engine makes its
 * summarization call (`purpose: 'compaction'`), answer it with the rendered
 * memory projection instead of a model call — pi-observational-memory's
 * `session_before_compact` equivalent. Compaction becomes a deterministic
 * render: no model call, no waiting on background workers.
 *
 * An empty projection declines ownership (`next()`), so the native
 * summarizer keeps working until memory exists.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Message, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: merges the compaction/* session event types into SessionEventMap.
import type {} from '@deepseek-ai/dsh-compaction'
import {
  buildCompactionProjection,
  renderSummary,
  type Observation,
  type Reflection,
  type VisibleMemoryRecord,
} from '../ledger/index.ts'
import type { OmRuntime } from '../runtime.ts'

/** A rendered memory summary parked between summarization and commit. */
type PendingVisible = {
  text: string
  fullFold: boolean
  upToSeq: number
  observations: Observation[]
  reflections: Reflection[]
}

/**
 * Recover the compaction cut: the seq of the last shadowed surface node.
 *
 * The summarization request replays the shadowed region verbatim (plus a
 * trailing instruction message the engine mints fresh), so the cut is the
 * last request message whose id exists in the session log. Request messages
 * minted for one call carry no durable id, so they are skipped. Falls back to
 * the log tip when no request message matches (unusual — e.g. a custom engine).
 */
function compactionCutSeq(session: Session, messages: readonly RequestMessage[]): number {
  const seqByMessageId = new Map<string, number>()
  for (const event of session.snapshotEvents()) {
    const data = event.data as { message?: { id?: unknown } } | undefined
    const messageId =
      event.type === 'user/message'
        ? (event.data as { id?: unknown }).id
        : data?.message?.id
    if (typeof messageId === 'string') seqByMessageId.set(messageId, event.seq)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].id
    if (typeof id !== 'string') continue
    const seq = seqByMessageId.get(id)
    if (seq !== undefined) return seq
  }
  return Math.max(0, session.seq - 1)
}

export function registerCompactionHook(ctx: Context, runtime: OmRuntime): void {
  /** sessionId → rendered memory awaiting its compaction's durable commit. */
  const pending = new Map<string, PendingVisible>()

  // The summarization call runs between `compaction/start` and
  // `compaction/summary`; the waterfall sees it by its `purpose` marker.
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (options.purpose !== 'compaction') return yield* next()
      const sessionId = options.sessionId
      if (sessionId === undefined) return yield* next()
      const session = ctx.sessions.get(sessionId)
      if (!session) return yield* next()
      if (session.header.origin === 'subagent') return yield* next()

      let parked: PendingVisible
      try {
        // A forked branch renders from the memory it inherited at the cut.
        await runtime.ensureInherited(ctx, session)
        const entries = await runtime.store.load(sessionId)
        // Fold through the compaction cut — the last shadowed surface node —
        // not the raw log tip: the retained tail stays verbatim in context, so
        // folding through it would duplicate those observations into the
        // summary (pi anchors this projection at firstKeptEntryId).
        const tipSeq = compactionCutSeq(session, options.messages)
        const projection = buildCompactionProjection(entries, tipSeq, {
          observationsPoolMaxTokens: runtime.config.observationsPoolMaxTokens,
        })
        const text = renderSummary(projection.reflections, projection.observations)
        if (text.length === 0) return yield* next()
        parked = {
          text,
          fullFold: projection.fullFold,
          upToSeq: tipSeq,
          observations: projection.observations,
          reflections: projection.reflections,
        }
        pending.set(sessionId, parked)
      } catch (error) {
        // Never let memory work break compaction: fall through to the native
        // summarizer on any failure.
        ctx.logger.warn(
          `[observational-memory] memory projection failed (${error instanceof Error ? error.message : String(error)}); using native summarization`,
        )
        return yield* next()
      }

      ctx.logger.info('[observational-memory] compaction rendered from memory (no model call)')
      yield { type: 'block-start', index: 0, blockType: 'text' } satisfies StreamChunk
      yield { type: 'text-delta', index: 0, text: parked.text } satisfies StreamChunk
      yield { type: 'block-end', index: 0, block: { type: 'text', text: parked.text } } satisfies StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
    },
    { global: true, prepend: true },
  )

  // Record what the agent now sees only once the compaction commits; a failed
  // compaction leaves visible memory untouched.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    const sessionId: string = session.id
    const parked = pending.get(sessionId)
    pending.delete(sessionId)
    if (!parked) return
    if (event.data.error !== undefined) return
    const record: VisibleMemoryRecord = {
      kind: 'visible-memory',
      text: parked.text,
      upToSeq: parked.upToSeq,
      fullFold: parked.fullFold,
      compactionId: event.data.compactionId,
      observations: parked.observations,
      reflections: parked.reflections,
    }
    void runtime.store.append(sessionId, record).catch(() => {})
  })

  // A session leaving the store never commits its parked render; drop it,
  // flush pending ledger writes, then release the cached ledger and every
  // per-session runtime entry (the JSONL on disk keeps memory durable).
  ctx.on('session/disposed', (session) => {
    const sessionId: string = session.id
    pending.delete(sessionId)
    void runtime.store.flush().then(() => {
      runtime.store.evict(sessionId)
      runtime.clearSession(sessionId)
    })
  })
}
