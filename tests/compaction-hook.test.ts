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
  dir = await mkdtemp(join(tmpdir(), 'om-compact-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Listeners = Map<string, ((...args: any[]) => unknown)[]>

function fakeCtx(events: unknown[], sessionId = 's1') {
  const listeners: Listeners = new Map()
  const session = {
    id: sessionId,
    header: { origin: undefined },
    seq: 42,
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

function compactionOptions(sessionId: string): GenerateOptions {
  return {
    provider: 'p',
    model: 'm',
    messages: [],
    purpose: 'compaction',
    sessionId: sessionId as never,
  }
}

describe('compaction hook', () => {
  it('renders memory as the compaction summary without a model call', async () => {
    const { ctx, listeners } = fakeCtx([])
    // Tiny pool max forces a full fold so reflections join observations.
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir, observationsPoolMaxTokens: 1 }), { onError: () => {} })
    const observation = makeObservation({ id: 'd4e5f6a1b2c3', content: 'User decided to switch to GraphQL.' })
    const reflection = makeReflection('The public API uses GraphQL.', [observation.id])
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: 3 })
    await runtime.store.append('s1', { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: 3 })
    registerCompactionHook(ctx, runtime)

    const waterfall = listeners.get('llm/stream')![0]
    const chunks = await collect(
      waterfall(compactionOptions('s1'), () => nativeChunks()) as AsyncIterable<StreamChunk>,
    )

    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(text).toContain('These are condensed memories from earlier in this session.')
    expect(text).toContain('The public API uses GraphQL.')
    expect(text).toContain('User decided to switch to GraphQL.')

    // Nothing visible recorded until the compaction commits.
    expect(runtime.store.entries('s1')).toHaveLength(2)

    // A failed compaction must not touch visible memory.
    const onEvent = listeners.get('session/event')![0]
    onEvent({ id: 's1' }, { type: 'compaction/end', data: { compactionId: 'k1', turn: 1, error: 'aborted' } })
    expect(runtime.store.entries('s1')).toHaveLength(2)
  })

  it('records visible memory when the compaction commits', async () => {
    const { ctx, listeners } = fakeCtx([])
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir, observationsPoolMaxTokens: 1 }), { onError: () => {} })
    const observation = makeObservation({ content: 'kept observation' })
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: 3 })
    registerCompactionHook(ctx, runtime)

    const waterfall = listeners.get('llm/stream')![0]
    await collect(waterfall(compactionOptions('s1'), () => nativeChunks()) as AsyncIterable<StreamChunk>)
    const onEvent = listeners.get('session/event')![0]
    onEvent({ id: 's1' }, { type: 'compaction/end', data: { compactionId: 'k1', turn: 1 } })
    await runtime.store.flush()

    const entries = runtime.store.entries('s1')
    expect(entries.at(-1)?.kind).toBe('visible-memory')
    const visible = entries.at(-1)
    if (visible?.kind !== 'visible-memory') throw new Error('unexpected')
    expect(visible.fullFold).toBe(true)
    expect(visible.observations.map((o) => o.id)).toEqual([observation.id])
    expect(visible.compactionId).toBe('k1')
  })

  it('delegates to the native summarizer when memory is empty', async () => {
    const { ctx, listeners } = fakeCtx([])
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    registerCompactionHook(ctx, runtime)

    const waterfall = listeners.get('llm/stream')![0]
    const chunks = await collect(
      waterfall(compactionOptions('s1'), () => nativeChunks()) as AsyncIterable<StreamChunk>,
    )
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(text).toBe('native summary')
  })

  it('ignores non-compaction calls', async () => {
    const { ctx, listeners } = fakeCtx([])
    const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
    registerCompactionHook(ctx, runtime)
    const waterfall = listeners.get('llm/stream')![0]
    const options = { ...compactionOptions('s1'), purpose: undefined }
    const chunks = await collect(waterfall(options, () => nativeChunks()) as AsyncIterable<StreamChunk>)
    expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'native summary')).toBe(true)
  })
})
