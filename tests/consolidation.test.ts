import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from '../src/config.ts'
import { maybeLaunchConsolidation, runConsolidationNow } from '../src/hooks/consolidation.ts'
import { buildObservationsRecorded, buildReflectionsRecorded } from '../src/ledger/index.ts'
import type { EventView } from '../src/serialize.ts'
import { hashId } from '../src/ids.ts'
import { OmRuntime } from '../src/runtime.ts'
import { fakeLlmCtx } from './fake-llm.ts'
import { resetSeqs, userEvent } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-pipeline-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeSession(events: EventView[]): Session {
  return {
    id: 's1',
    header: { origin: undefined },
    seq: events.length,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  } as unknown as Session
}

function fakeCtx(turns: Parameters<typeof fakeLlmCtx>[0]) {
  const { ctx, requests, callCount } = fakeLlmCtx(turns)
  ctx.agents = { get: () => undefined }
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 200_000 } })
  ctx.get = () => undefined
  const warnings: string[] = []
  const infos: string[] = []
  ctx.logger = {
    info: (m: string) => void infos.push(m),
    warn: (m: string) => void warnings.push(m),
  }
  return { ctx, requests, callCount, warnings, infos }
}

function longConversation(length: number): EventView[] {
  resetSeqs()
  return Array.from({ length }, (_, i) => userEvent(`message ${i} ${'content '.repeat(length)}`))
}

describe('consolidation pipeline', () => {
  it('records observations when the observer clock is due', async () => {
    const events = longConversation(20)
    const { ctx } = fakeCtx([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_observations',
            arguments: JSON.stringify({
              observations: [
                {
                  timestamp: '2026-01-15 14:30',
                  content: 'User kicked off a long task.',
                  relevance: 'medium',
                  sourceEventSeqs: [0],
                },
              ],
            }),
          },
        ],
      },
      { text: 'done' },
    ])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))

    const entries = runtime.store.entries('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'observations-recorded', coversUpToSeq: events.length - 1 })
    if (entries[0].kind !== 'observations-recorded') throw new Error('unexpected')
    expect(entries[0].observations[0].content).toBe('User kicked off a long task.')
  })

  it('does nothing in passive mode', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx([{ text: 'unused' }])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, passive: true, storageDir: dir }), { onError: () => {} })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    expect(callCount()).toBe(0)
    expect(runtime.store.entries('s1')).toHaveLength(0)
  })

  it('runs reflector and dropper after a successful reflection when the pool is over target', async () => {
    const events = longConversation(20)
    const bigContent = `durable fact ${'x'.repeat(400)}`
    const secondContent = `second ${'y'.repeat(400)}`
    const firstId = hashId(bigContent)
    const secondId = hashId(secondContent)
    const { ctx } = fakeCtx([
      // Observer
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_observations',
            arguments: JSON.stringify({
              observations: [
                { timestamp: '2026-01-15 14:30', content: bigContent, relevance: 'high', sourceEventSeqs: [0] },
                { timestamp: '2026-01-15 14:31', content: secondContent, relevance: 'low', sourceEventSeqs: [1] },
              ],
            }),
          },
        ],
      },
      { text: 'observed' },
      // Reflector
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'record_reflections',
            arguments: JSON.stringify({
              reflections: [{ content: 'The task uses durable facts.', supportingObservationIds: [firstId] }],
            }),
          },
        ],
      },
      { text: 'reflected' },
      // Dropper: pool is over target; the low observation is the safe drop.
      {
        toolCalls: [{ id: 'c3', name: 'drop_observations', arguments: JSON.stringify({ ids: [secondId] }) }],
      },
      { text: 'dropped' },
    ])
    const runtime = new OmRuntime(
      resolveConfig({
        observeAfterTokens: 10,
        reflectAfterTokens: 10,
        observationsPoolMaxTokens: 100,
        storageDir: dir,
      }),
      { onError: () => {} },
    )

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))

    const entries = runtime.store.entries('s1')
    expect(entries.map((entry) => entry.kind)).toEqual([
      'observations-recorded',
      'reflections-recorded',
      'observations-dropped',
    ])
    const drop = entries[2]
    if (drop.kind !== 'observations-dropped') throw new Error('unexpected')
    expect(drop.observationIds).toEqual([secondId])
  })

  it('backs off after a deliberate empty observer run', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx([{ text: 'nothing worth recording' }])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
    expect(runtime.store.entries('s1')).toHaveLength(0)

    // Same span, no new tokens: the backoff suppresses a re-fire.
    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
  })

  it('keeps the pipeline alive when a worker stream fails', async () => {
    const events = longConversation(20)
    const { ctx, warnings } = fakeCtx([{ finish: 'error' }])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    expect(runtime.lastObserverError.get('s1')).toContain('boom')
    expect(warnings.some((m) => m.includes('observer failed'))).toBe(true)
    expect(runtime.store.entries('s1')).toHaveLength(0)
  })
  it('warns on consecutive empty observer runs', async () => {
    const events = longConversation(20)
    const { ctx, warnings, infos } = fakeCtx([{ text: 'nothing worth recording' }])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })

    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    expect(runtime.store.entries('s1')).toHaveLength(0)
    expect(infos.some((m) => m.includes('found nothing new'))).toBe(true)
    expect(warnings.some((m) => m.includes('consecutive runs'))).toBe(false)

    // The backoff lifts once another observeAfterTokens worth of source text
    // accumulates; a second consecutive empty verdict escalates to a warning.
    const more = [...events, userEvent('extra source text to clear the backoff, deliberately long enough to pass the ten-token gate', events.length)]
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(more))
    expect(warnings.some((m) => m.includes('2 consecutive runs'))).toBe(true)
  })

  it('reports the consecutive-failure streak in worker error debug events and warnings', async () => {
    const events = longConversation(20)
    const { ctx, warnings } = fakeCtx([{ finish: 'error' }])
    const runtime = new OmRuntime(
      resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, debugLog: true, storageDir: dir }),
      { onError: () => {} },
    )
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    await maybeLaunchConsolidation(ctx, runtime, session)

    expect(warnings.filter((m) => m.includes('observer failed'))).toEqual([
      expect.stringContaining('consecutive failures: 1'),
      expect.stringContaining('consecutive failures: 2'),
    ])

    // Debug-log writes are fire-and-forget; poll briefly until both land.
    const debugPath = join(dir, 'debug', 's1.ndjson')
    let streaks: number[] = []
    for (let attempt = 0; attempt < 50 && streaks.length < 2; attempt++) {
      streaks = await readFile(debugPath, 'utf8')
        .then((text) =>
          text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event?: string; consecutiveFailures?: number })
            .filter((entry) => entry.event === 'observer.error')
            .map((entry) => entry.consecutiveFailures ?? -1),
        )
        .catch(() => [] as number[])
      if (streaks.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(streaks).toEqual([1, 2])
  })

  it('suspends the model override after the configured consecutive-failure streak', async () => {
    const events = longConversation(20)
    const { ctx, requests } = fakeCtx([
      { finish: 'error' },
      { finish: 'error' },
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'record_observations',
            arguments: JSON.stringify({
              observations: [
                {
                  timestamp: '2026-01-15 14:30',
                  content: 'Recovered on the session model.',
                  relevance: 'medium',
                  sourceEventSeqs: [0],
                },
              ],
            }),
          },
        ],
      },
      { text: 'done' },
    ])
    const errors: string[] = []
    const runtime = new OmRuntime(
      resolveConfig({
        observeAfterTokens: 10,
        reflectAfterTokens: 100_000,
        model: { provider: 'ov', id: 'broken' },
        modelFallbackAfterFailures: 2,
        storageDir: dir,
      }),
      { onError: (m) => void errors.push(m) },
    )
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(runtime.lastObserverError.get('s1')).toContain('boom')

    // Streak reached the threshold: the third run resolves the session model
    // (the fake session's routed request header is p/m) and recovers.
    await maybeLaunchConsolidation(ctx, runtime, session)

    expect(requests.map((r) => `${r.provider}/${r.model}`)).toEqual(['ov/broken', 'ov/broken', 'p/m', 'p/m'])
    expect(runtime.store.entries('s1')).toHaveLength(1)
    expect(errors.filter((m) => m.includes('suspended'))).toHaveLength(1)
  })

  it('never suspends the override when the failure threshold is 0', async () => {
    const events = longConversation(20)
    const { ctx, requests } = fakeCtx([{ finish: 'error' }])
    const runtime = new OmRuntime(
      resolveConfig({
        observeAfterTokens: 10,
        reflectAfterTokens: 100_000,
        model: { provider: 'ov', id: 'broken' },
        storageDir: dir,
      }),
      { onError: () => {} },
    )
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    await maybeLaunchConsolidation(ctx, runtime, session)
    await maybeLaunchConsolidation(ctx, runtime, session)

    expect(requests.map((r) => `${r.provider}/${r.model}`)).toEqual(['ov/broken', 'ov/broken', 'ov/broken'])
  })

  it('re-arms the override on an override-path success', async () => {
    const events = longConversation(20)
    const record = (seq: number) => ({
      toolCalls: [
        {
          id: `c${seq}`,
          name: 'record_observations',
          arguments: JSON.stringify({
            observations: [
              {
                timestamp: '2026-01-15 14:30',
                content: `recorded at seq ${seq}`,
                relevance: 'medium',
                sourceEventSeqs: [seq],
              },
            ],
          }),
        },
      ],
    })
    const { ctx, requests } = fakeCtx([
      { finish: 'error' },
      record(19),
      { text: 'done' },
      { finish: 'error' },
      { finish: 'error' },
      record(21),
      { text: 'done' },
    ])
    const runtime = new OmRuntime(
      resolveConfig({
        observeAfterTokens: 10,
        reflectAfterTokens: 100_000,
        model: { provider: 'ov', id: 'flaky' },
        modelFallbackAfterFailures: 2,
        storageDir: dir,
      }),
      { onError: () => {} },
    )

    // 1st run: fails (streak 1).
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events))
    // 2nd run: override succeeds and records — the streak resets.
    const events2 = [...events, userEvent('more source text after the first success, deliberately long enough to stay due', events.length)]
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events2))
    // 3rd and 4th runs fail again (streak 1, then 2 → suspension trips).
    const events3 = [...events2, userEvent('even more source text for another run, deliberately long enough to stay due again', events2.length)]
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events3))
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events3))
    // 5th run: suspended, falls back to the session model (p/m).
    await maybeLaunchConsolidation(ctx, runtime, fakeSession(events3))

    expect(requests.map((r) => `${r.provider}/${r.model}`)).toEqual([
      'ov/flaky',
      'ov/flaky',
      'ov/flaky',
      'ov/flaky',
      'ov/flaky',
      'p/m',
      'p/m',
    ])
  })
})

describe('manual consolidation run (Memory tab "run now")', () => {
  const observerTurns = [
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'record_observations',
          arguments: JSON.stringify({
            observations: [
              {
                timestamp: '2026-01-15 14:30',
                content: 'User kicked off a long task.',
                relevance: 'medium',
                sourceEventSeqs: [0],
              },
            ],
          }),
        },
      ],
    },
    { text: 'done' },
    // Forced reflector finds the fresh observations but crystallizes nothing.
    { text: 'nothing to crystallize' },
  ]

  it('runs the full pipeline in passive mode, ignoring the token clocks', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx(observerTurns)
    const runtime = new OmRuntime(
      resolveConfig({ passive: true, observeAfterTokens: 1_000_000, reflectAfterTokens: 1_000_000, storageDir: dir }),
      { onError: () => {} },
    )

    const ran = await runConsolidationNow(ctx, runtime, fakeSession(events))

    expect(ran).toBe(true)
    expect(callCount()).toBe(3)
    const entries = runtime.store.entries('s1')
    expect(entries.map((entry) => entry.kind)).toEqual(['observations-recorded'])
    expect(entries[0]).toMatchObject({ coversUpToSeq: events.length - 1 })
  })

  it('returns false while a run is already in flight', async () => {
    const events = longConversation(20)
    const { ctx } = fakeCtx(observerTurns)
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, storageDir: dir }), { onError: () => {} })
    const session = fakeSession(events)

    // The slot is claimed synchronously, before the pipeline's first await.
    const first = runConsolidationNow(ctx, runtime, session)
    await expect(runConsolidationNow(ctx, runtime, session)).resolves.toBe(false)
    await expect(first).resolves.toBe(true)
    // The guard released: a later manual run executes again.
    await expect(runConsolidationNow(ctx, runtime, session)).resolves.toBe(true)
  })

  it('makes no model call over an empty backlog', async () => {
    const { ctx, callCount } = fakeCtx(observerTurns)
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, storageDir: dir }), { onError: () => {} })

    await expect(runConsolidationNow(ctx, runtime, fakeSession([]))).resolves.toBe(true)
    expect(callCount()).toBe(0)
    expect(runtime.store.entries('s1')).toHaveLength(0)
  })

  it('spends no model call when memory is already up to date', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx(observerTurns)
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, storageDir: dir }), { onError: () => {} })
    // Ledger fully covering the session: nothing new for either stage.
    const observations = buildObservationsRecorded(
      [{ id: hashId('covered fact'), content: 'covered fact', timestamp: '2026-01-15 14:30', relevance: 'medium', sourceEventSeqs: [0], tokenCount: 10 }],
      events.length - 1,
    )
    const reflections = buildReflectionsRecorded(
      [{ id: hashId('covered conclusion'), content: 'covered conclusion', supportingObservationIds: [hashId('covered fact')], tokenCount: 10 }],
      events.length - 1,
    )
    if (!observations || !reflections) throw new Error('fixture records must build')
    await runtime.store.append('s1', observations)
    await runtime.store.append('s1', reflections)

    await expect(runConsolidationNow(ctx, runtime, fakeSession(events))).resolves.toBe(true)
    expect(callCount()).toBe(0)
    expect(runtime.store.entries('s1')).toHaveLength(2)
  })

  it('is the explicit retry that bypasses the deliberate-empty backoff', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx([{ text: 'nothing worth recording' }])
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, reflectAfterTokens: 100_000, storageDir: dir }), {
      onError: () => {},
    })
    const session = fakeSession(events)

    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
    // Same span: the backoff suppresses the automatic re-fire…
    await maybeLaunchConsolidation(ctx, runtime, session)
    expect(callCount()).toBe(1)
    // …but the manual run ignores it.
    await expect(runConsolidationNow(ctx, runtime, session)).resolves.toBe(true)
    expect(callCount()).toBe(2)
  })

  it('refuses subagent sessions, which have no memory of their own', async () => {
    const events = longConversation(20)
    const { ctx, callCount } = fakeCtx(observerTurns)
    const runtime = new OmRuntime(resolveConfig({ observeAfterTokens: 10, storageDir: dir }), { onError: () => {} })
    const subagent = Object.assign(fakeSession(events), { header: { origin: 'subagent' as const } })

    await expect(runConsolidationNow(ctx, runtime, subagent)).resolves.toBe(false)
    expect(callCount()).toBe(0)
    expect(runtime.consolidationInFlight.size).toBe(0)
  })
})
