/**
 * Minimal tool-calling worker loop over `ctx.llm.stream()`.
 *
 * DSH has no plugin-facing bare agent loop, and the memory workers each need
 * exactly one recording tool with a turn cap, so this loop stays deliberately
 * small: stream a call, execute requested tool calls sequentially, feed
 * results back, repeat. Adapter failures arrive as terminal `finish` chunks
 * (not throws) and are rethrown as {@link WorkerStreamError} so callers can
 * tell a hard failure from a deliberate empty result.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type ContextFormed,
  type FinishReason,
  type Message,
  type ToolCallBlock,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

/** Message-source kind this plugin stamps on the prompts it mints. */
export const WORKER_SOURCE_KIND = 'observational-memory'

// The message source vocabulary is producer-owned: there is no catch-all
// `plugin` kind (removed in DSH 0.1.7), so the worker prompt declares its own.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'observational-memory': { kind: 'observational-memory' } & ContextFormed
  }
}

/** Thrown when a worker's model stream ends in error/aborted/max-tokens. */
export class WorkerStreamError extends Error {
  constructor(
    readonly finishKind: FinishReason['kind'],
    detail?: string,
  ) {
    super(`worker stream ended with finish kind "${finishKind}"${detail ? `: ${detail}` : ''}`)
    this.name = 'WorkerStreamError'
  }
}

export interface WorkerTool {
  schema: ToolSchema
  /** Execute one parsed tool call; the returned text goes back to the model. */
  execute(args: unknown): Promise<string> | string
}

export interface WorkerLoopOptions {
  provider: string
  model: string
  system: string
  userText: string
  tools: WorkerTool[]
  maxTurns: number
  maxTokens?: number
  reasoningEffort?: string
  signal?: AbortSignal
}

export interface WorkerLoopResult {
  turns: number
  finish: FinishReason
}

function fail(finish: FinishReason): never {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      throw new WorkerStreamError(finish.kind, finish.failure.message)
    case 'max-tokens':
      throw new WorkerStreamError('max-tokens', 'worker response truncated at the token cap')
    default:
      throw new WorkerStreamError(finish.kind)
  }
}

/** Run the loop; resolves when the model stops without further tool calls. */
export async function runWorkerLoop(ctx: Context, options: WorkerLoopOptions): Promise<WorkerLoopResult> {
  const messages: Message[] = [
    createUserMessage({
      content: [{ type: 'text', text: options.userText }],
      source: { kind: WORKER_SOURCE_KIND },
    }),
  ]
  const tools: ToolSchema[] = options.tools.map((tool) => tool.schema)
  const maxTurns = Math.max(1, options.maxTurns)

  let turns = 0
  let finish: FinishReason = { kind: 'stop' }
  while (turns < maxTurns) {
    turns += 1
    const assembler = new BlockAssembler()
    const stream = ctx.llm.stream({
      provider: options.provider,
      model: options.model,
      messages,
      system: options.system,
      tools,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort as never } : {}),
      signal: options.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)
    finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted' || finish.kind === 'max-tokens') fail(finish)

    const blocks = assembler.blocks()
    messages.push(
      createAssistantMessage({
        content: blocks,
        source: { provider: options.provider, model: options.model },
      }),
    )

    const calls = blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')
    // Execute any tool calls regardless of the finish label: some adapters
    // report 'stop' with calls pending. A call-free response ends the loop.
    if (calls.length === 0) break

    for (const call of calls) {
      const tool = options.tools.find((candidate) => candidate.schema.name === call.name)
      let text: string
      let isError = false
      if (!tool) {
        text = `Unknown tool "${call.name}".`
        isError = true
      } else {
        try {
          text = await tool.execute(JSON.parse(call.arguments))
        } catch (error) {
          text = `Tool error: ${error instanceof Error ? error.message : String(error)}`
          isError = true
        }
      }
      messages.push(
        createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text }],
          isError,
        }),
      )
    }
  }

  return { turns, finish }
}
