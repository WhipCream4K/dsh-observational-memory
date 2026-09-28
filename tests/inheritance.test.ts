import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from '../src/config.ts'
import { maybeLaunchConsolidation } from '../src/hooks/consolidation.ts'
import {
  buildObservationsRecorded,
  buildReflectionsRecorded,
  type LedgerEntry,
  type VisibleMemoryRecord,
} from '../src/ledger/index.ts'
import { OmRuntime } from '../src/runtime.ts'
import { fakeLlmCtx } from './fake-llm.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-inherit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeRuntime(config: Record<string, unknown> = {}): OmRuntime {
  return new OmRuntime(resolveConfig({ storageDir: dir, ...config }), { onError: () => {} })
}

/** A session stub carrying the fork-lineage fields inheritance reads. */
function forkSession(id: string, parentId: string | undefined, inheritedEventCount: number): Session {
  return {
    id,
    header: { origin: undefined, ...(parentId === undefined ? {} : { parentSession: parentId as SessionId }) },
    inheritedEventCount,
    seq: inheritedEventCount,
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  } as unknown as Session
}

/** A ctx stub whose session store resolves the given attached sessions. */
function fakeCtx(attached: Session[] = []): Context {
  return fakeCtxWithLlm(attached).ctx
}

/** The same stub with its scripted-llm call counter exposed. */
function fakeCtxWithLlm(attached: Session[] = []): { ctx: Context; callCount: () => number } {
  const { ctx, callCount } = fakeLlmCtx([])
  ctx.sessions = { get: (id: string) => attached.find((session) => session.id === id) }
  ctx.agents = { get: () => undefined }
  ctx.logger = { info: () => {}, warn: () => {} }
  return { ctx: ctx as Context, callCount }
}

function visibleRecord(upToSeq: number, text: string): VisibleMemoryRecord {
  return { kind: 'visible-memory', text, upToSeq, fullFold: true, observations: [], reflections: [] }
}

/** Parent ledger records straddling a fork boundary at seq 20. */
function parentRecords(): { within: LedgerEntry[]; beyond: LedgerEntry[] } {
  const earlyObservations = buildObservationsRecorded(
    [makeObservation({ content: 'Early fact one.' }), makeObservation({ content: 'Early fact two.' })],
    10,
  )
  const reflections = buildReflectionsRecorded([makeReflection('Early conclusion.', ['unused'])], 10)
  const lateObservations = buildObservationsRecorded([makeObservation({ content: 'Future fact.' })], 30)
  if (!earlyObservations || !reflections || !lateObservations) throw new Error('fixture records must build')
  return {
    within: [earlyObservations, reflections, visibleRecord(10, 'visible at 10')],
    beyond: [lateObservations, visibleRecord(40, 'visible at 40')],
  }
}

describe('fork memory inheritance', () => {
  it('copies the parent ledger through the fork boundary on first touch', async () => {
    const runtime = makeRuntime()
    const { within, beyond } = parentRecords()
    for (const entry of [...within, ...beyond]) await runtime.store.append('parent', entry)

    // inheritedEventCount 21 → the last inherited seq is 20.
    const child = forkSession('child', 'parent', 21)
    await runtime.ensureInherited(fakeCtx(), child)

    expect(await runtime.store.load('child')).toEqual(within)
  })

  it('leaves an empty prefix (boundary -1) untouched', async () => {
    const runtime = makeRuntime()
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('parent', entry)

    await runtime.ensureInherited(fakeCtx(), forkSession('child', 'parent', 0))
    expect(await runtime.store.load('child')).toEqual([])
  })

  it('does nothing for a session without a fork parent', async () => {
    const runtime = makeRuntime()
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('parent', entry)

    await runtime.ensureInherited(fakeCtx(), forkSession('plain', undefined, 0))
    expect(await runtime.store.load('plain')).toEqual([])
  })

  it('never re-inherits once the child owns records', async () => {
    const runtime = makeRuntime()
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('parent', entry)

    const child = forkSession('child', 'parent', 21)
    await runtime.ensureInherited(fakeCtx(), child)
    await runtime.ensureInherited(fakeCtx(), child)
    const once = await runtime.store.load('child')
    expect(once).toEqual(within)
    // `load` hands back the live cached array; pin the count before appends.
    const countBefore = once.length

    // Records appended by the child itself also close inheritance.
    const own = buildObservationsRecorded([makeObservation({ content: 'Branch-local fact.' })], 25)
    if (!own) throw new Error('fixture record must build')
    await runtime.store.append('child', own)
    await runtime.ensureInherited(fakeCtx(), child)
    expect((await runtime.store.load('child')).length).toBe(countBefore + 1)
  })

  it('walks past an empty parent ledger to the grandparent (rollback of a rollback)', async () => {
    const runtime = makeRuntime()
    const { within, beyond } = parentRecords()
    for (const entry of [...within, ...beyond]) await runtime.store.append('grandparent', entry)

    // The middle branch never consolidated: nothing under its id, but its
    // header still names the grandparent while attached.
    const middle = forkSession('middle', 'grandparent', 31)
    const child = forkSession('child', 'middle', 21)
    await runtime.ensureInherited(fakeCtx([middle]), child)

    expect(await runtime.store.load('child')).toEqual(within)
  })

  it('stops the walk at a detached ancestor after reading its ledger', async () => {
    const runtime = makeRuntime()
    // The parent is detached: its (empty) ledger is read, its lineage is
    // out of reach, so nothing arrives even though a grandparent has records.
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('grandparent', entry)

    const child = forkSession('child', 'middle', 21)
    await runtime.ensureInherited(fakeCtx(), child)
    expect(await runtime.store.load('child')).toEqual([])
  })

  it('shares one run between concurrent touches', async () => {
    const runtime = makeRuntime()
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('parent', entry)

    const child = forkSession('child', 'parent', 21)
    await Promise.all([
      runtime.ensureInherited(fakeCtx(), child),
      runtime.ensureInherited(fakeCtx(), child),
    ])
    expect(await runtime.store.load('child')).toEqual(within)
  })

  it('inherits in passive mode from the consolidation trigger, without running workers', async () => {
    const runtime = makeRuntime({ passive: true, observeAfterTokens: 1 })
    const { within } = parentRecords()
    for (const entry of within) await runtime.store.append('parent', entry)

    const child = forkSession('child', 'parent', 21)
    const { ctx, callCount } = fakeCtxWithLlm()
    await maybeLaunchConsolidation(ctx, runtime, child)

    expect(await runtime.store.load('child')).toEqual(within)
    // Passive: the pipeline itself never launched (no model call happened).
    expect(callCount()).toBe(0)
    expect(runtime.consolidationInFlight.size).toBe(0)
  })
})
