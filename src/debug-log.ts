/**
 * Opt-in per-session debug log: NDJSON lines under
 * `<storageRoot>/debug/<sessionId>.ndjson`. Never throws; debug logging must
 * not break memory work.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ledgerFileName } from './ledger/store.ts'

/** The NDJSON file one session's debug events append to. */
export function debugLogPath(rootDir: string, sessionId: string): string {
  return join(rootDir, 'debug', ledgerFileName(sessionId).replace(/\.jsonl$/, '.ndjson'))
}

export class DebugLog {
  private ready = false
  /**
   * Serializes appends. Without it, `log` calls made in quick succession race
   * their `mkdir` + `appendFile` and land on disk out of order, so a reader
   * cannot rely on the file preserving event order.
   */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly rootDir: string | undefined,
    private readonly onError: (message: string) => void,
  ) {}

  /** Whether logging is active for this call. */
  get enabled(): boolean {
    return this.rootDir !== undefined
  }

  /** Append one event row; fire-and-forget with contained errors, in call order. */
  log(sessionId: string, event: string, data: Record<string, unknown> = {}): void {
    if (!this.rootDir) return
    const line = `${JSON.stringify({ time: new Date().toISOString(), sessionId, event, ...data })}\n`
    this.tail = this.tail.then(() => this.write(debugLogPath(this.rootDir as string, sessionId), line))
  }

  private async write(path: string, line: string): Promise<void> {
    try {
      if (!this.ready) {
        await mkdir(join(this.rootDir as string, 'debug'), { recursive: true })
        this.ready = true
      }
      await appendFile(path, line, 'utf8')
    } catch (error) {
      this.onError(`observational-memory: debug log write failed: ${String(error)}`)
    }
  }
}
