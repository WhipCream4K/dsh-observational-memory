import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig } from '../src/config.ts'
import { registerRecallTool } from '../src/tools/recall.ts'
import { OmRuntime } from '../src/runtime.ts'
import { makeObservation, makeReflection, resetSeqs, userEvent } from './fixtures.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'om-recall-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const runtime = new OmRuntime(resolveConfig({ storageDir: dir }), { onError: () => {} })
  let tool: ToolDefinition | undefined
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tool = definition
      },
    },
  } as unknown as Context
  registerRecallTool(ctx, runtime)
  if (!tool) throw new Error('tool not registered')
  return { runtime, tool }
}

function execWith(events: ReturnType<typeof userEvent>[]) {
  return {
    agent: {
      session: {
        id: 's1',
        // The Session contract guarantees header/inheritedEventCount exist.
        header: {},
        inheritedEventCount: 0,
        snapshotEvents: () => events,
      },
    },
    signal: new AbortController().signal,
  } as never
}

describe('recall tool', () => {
  it('rejects malformed ids', async () => {
    const { tool } = await setup()
    const value = await tool.execute({ id: 'nope' }, execWith([]))
    expect(value).toContain('12 lowercase hex')
  })

  it('reports unknown ids', async () => {
    const { tool } = await setup()
    const value = await tool.execute({ id: 'a1b2c3d4e5f6' }, execWith([]))
    expect(value).toContain('No observation or reflection')
  })

  it('recovers observation evidence with source text', async () => {
    resetSeqs()
    const source = userEvent('We run Postgres in production.')
    const observation = makeObservation({ content: 'User stated production runs Postgres.', sourceEventSeqs: [source.seq] })
    const { runtime, tool } = await setup()
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq })

    const value = (await tool.execute({ id: observation.id }, execWith([source]))) as string
    expect(value).toContain('[User @')
    expect(value).toContain('We run Postgres in production.')
  })

  it('recovers a reflection with its supporting observation', async () => {
    resetSeqs()
    const source = userEvent('Chose GraphQL for the public API.')
    const observation = makeObservation({ content: 'User chose GraphQL.', sourceEventSeqs: [source.seq] })
    const reflection = makeReflection('The public API uses GraphQL.', [observation.id])
    const { runtime, tool } = await setup()
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq })
    await runtime.store.append('s1', { kind: 'reflections-recorded', reflections: [reflection], coversUpToSeq: source.seq })

    const value = (await tool.execute({ id: reflection.id }, execWith([source]))) as string
    expect(value).toContain('Reflections:')
    expect(value).toContain('The public API uses GraphQL.')
    expect(value).toContain('Observations:')
    expect(value).toContain('User chose GraphQL.')
    expect(value).toContain('Sources:')
  })

  it('marks dropped observations without hiding them', async () => {
    resetSeqs()
    const source = userEvent('old detail')
    const observation = makeObservation({ content: 'old detail', sourceEventSeqs: [source.seq] })
    const { runtime, tool } = await setup()
    await runtime.store.append('s1', { kind: 'observations-recorded', observations: [observation], coversUpToSeq: source.seq })
    await runtime.store.append('s1', { kind: 'observations-dropped', observationIds: [observation.id], coversUpToSeq: source.seq })

    const value = (await tool.execute({ id: observation.id }, execWith([source]))) as string
    expect(value).toContain('[dropped]')
    expect(value).toContain('old detail')
  })
})
