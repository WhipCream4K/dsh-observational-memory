import { describe, expect, it } from 'vitest'
import { runWorkerLoop, WorkerStreamError } from '../src/workers/loop.ts'
import { fakeLlmCtx } from './fake-llm.ts'

const echoTool = {
  schema: {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  execute(args: unknown): string {
    return `echo: ${(args as { text: string }).text}`
  },
}

describe('runWorkerLoop', () => {
  it('executes tool calls and feeds results back until the model stops', async () => {
    const { ctx, requests } = fakeLlmCtx([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hi"}' }] },
      { text: 'done' },
    ])
    const result = await runWorkerLoop(ctx, {
      provider: 'p',
      model: 'm',
      system: 'sys',
      userText: 'user',
      tools: [echoTool],
      maxTurns: 4,
    })
    expect(result.turns).toBe(2)
    expect(result.finish.kind).toBe('stop')
    // Second request carries the assistant tool call and the tool result.
    const second = requests[1].messages as { role: string; content: { type: string; text?: string }[] }[]
    expect(second.at(-2)?.role).toBe('assistant')
    const toolResult = second.at(-1)
    // DSH 0.1.7 gives a tool result its own role; the worker loop feeds it back
    // as a first-class tool message rather than a user-role echo.
    expect(toolResult?.role).toBe('tool')
    expect(JSON.stringify(toolResult?.content)).toContain('echo: hi')
  })

  it('caps the number of turns', async () => {
    const { ctx, callCount } = fakeLlmCtx([
      { toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"a"}' }] },
    ])
    const result = await runWorkerLoop(ctx, {
      provider: 'p',
      model: 'm',
      system: 'sys',
      userText: 'user',
      tools: [echoTool],
      maxTurns: 3,
    })
    expect(result.turns).toBe(3)
    expect(callCount()).toBe(3)
  })

  it('throws WorkerStreamError on a terminal error finish', async () => {
    const { ctx } = fakeLlmCtx([{ finish: 'error' }])
    await expect(
      runWorkerLoop(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u', tools: [echoTool], maxTurns: 2 }),
    ).rejects.toBeInstanceOf(WorkerStreamError)
  })

  it('returns tool errors to the model instead of throwing', async () => {
    const unknownCall = { id: 'c9', name: 'nope', arguments: '{}' }
    const { ctx, requests } = fakeLlmCtx([{ toolCalls: [unknownCall] }, { text: 'ok' }])
    const result = await runWorkerLoop(ctx, {
      provider: 'p',
      model: 'm',
      system: 's',
      userText: 'u',
      tools: [echoTool],
      maxTurns: 4,
    })
    expect(result.turns).toBe(2)
    expect(JSON.stringify(requests[1].messages)).toContain('Unknown tool')
  })
})
