import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { Config, resolveConfig } from '../src/config.ts'
import { registerCompactionHook } from '../src/hooks/compaction.ts'
import { OmRuntime } from '../src/runtime.ts'
import { makeObservation, makeReflection } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-cut-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Listeners = Map<string, ((...args: any[]) => unknown)[]>

function fakeCtx(events: any[], sessionId = 's1') {
  const listeners: Listeners = new Map()
  const session = {
    id: sessionId,
    header: { origin: undefined },
    seq: events.length + 1,
    snapshotEvents: () => events,
  } as unknown as Session
  const ctx = {
    on: (name: string, fn: (...args: any[]) => unknown) => {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
    },
    sessions: { get: (id: string) => (id === sessionId ? session : undefined) },
    logger: { info: () => {}, warn: () => {} },
  } as unknown as Context
  return { ctx, listeners, session }
}

function userMessageEvent(seq: number, id: string, text: string) {
  return {
    seq,
    type: 'user/message',
    time: 0,
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

async function* nativeChunks(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'native summary' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native summary' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('compaction cut anchoring', () => {
  it('folds memory through the shadowed cut, not the log tip', async () => {
    // Log: two shadowed messages (m1, m2) followed by retained tail (m3, m4).
    const events = [
      userMessageEvent(0, 'm1', 'shadowed one'),
      userMessageEvent(1, 'm2', 'shadowed two'),
      userMessageEvent(2, 'm3', 'retained three'),
      userMessageEvent(3, 'm4', 'retained four'),
    ]
    const { ctx, listeners } = fakeCtx(events)
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })

    const shadowedObs = makeObservation({ content: 'about the shadowed region', sourceEventSeqs: [1] })
    const retainedObs = makeObservation({ content: 'about the retained tail', sourceEventSeqs: [3] })
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [shadowedObs], coversUpToSeq: 1 })
    await runtime.store.append('s1', {
      kind: 'observations-recorded',
      observations: [retainedObs],
      coversUpToSeq: 3,
    })
    registerCompactionHook(ctx, runtime)

    // The summarization request replays the shadowed region plus the engine's
    // fresh instruction message (id not in the log).
    const options = {
      provider: 'p',
      model: 'm',
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'shadowed one' }], source: { kind: 'user' } },
        { id: 'm2', role: 'user', content: [{ type: 'text', text: 'shadowed two' }], source: { kind: 'user' } },
        { id: 'instr', role: 'user', content: [{ type: 'text', text: 'COMPACTION INSTRUCTION' }], source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } },
      ],
      purpose: 'compaction',
      sessionId: 's1',
    } as unknown as GenerateOptions

    const waterfall = listeners.get('llm/stream')![0]
    const chunks = await collect(waterfall(options, () => nativeChunks()) as AsyncIterable<StreamChunk>)
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')

    expect(text).toContain('about the shadowed region')
    // The retained tail stays verbatim in context; it must NOT be duplicated
    // into the memory summary.
    expect(text).not.toContain('about the retained tail')
  })

  it('falls back to the log tip when no request message matches', async () => {
    const events = [userMessageEvent(0, 'm1', 'one')]
    const { ctx, listeners } = fakeCtx(events)
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    const observation = makeObservation({ content: 'tip observation', sourceEventSeqs: [0] })
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: 0 })
    registerCompactionHook(ctx, runtime)

    const options = {
      provider: 'p',
      model: 'm',
      messages: [],
      purpose: 'compaction',
      sessionId: 's1',
    } as unknown as GenerateOptions
    const waterfall = listeners.get('llm/stream')![0]
    const chunks = await collect(waterfall(options, () => nativeChunks()) as AsyncIterable<StreamChunk>)
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(text).toContain('tip observation')
  })

  it('records visible memory with reflection support ids intact', async () => {
    const events = [userMessageEvent(0, 'm1', 'one')]
    const { ctx, listeners } = fakeCtx(events)
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir, observationsPoolMaxTokens: 1 }), { onError: () => {} })
    const observation = makeObservation({ content: 'evidence', sourceEventSeqs: [0] })
    const reflection = makeReflection('durable fact', [observation.id])
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: 0 })
    await runtime.store.append('s1', { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: 0 })
    registerCompactionHook(ctx, runtime)

    const options = {
      provider: 'p', model: 'm', messages: [], purpose: 'compaction', sessionId: 's1',
    } as unknown as GenerateOptions
    const waterfall = listeners.get('llm/stream')![0]
    await collect(waterfall(options, () => nativeChunks()) as AsyncIterable<StreamChunk>)
    const onEvent = listeners.get('session/event')![0]
    onEvent({ id: 's1' }, { type: 'compaction/end', data: { compactionId: 'k9', turn: 1 } })
    await runtime.store.flush()

    const visible = runtime.store.entries('s1').at(-1)
    if (visible?.kind !== 'visible-memory') throw new Error('expected visible-memory')
    expect(visible.reflections[0].supportingObservationIds).toEqual([observation.id])
  })
})
