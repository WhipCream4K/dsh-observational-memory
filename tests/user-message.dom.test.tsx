// @vitest-environment happy-dom
/**
 * Interaction tests for the rollback action: real DOM mounting so the click
 * path (gate → window coverage → anchor resolution → rollback call) runs.
 * ui-primitives is factory-mocked; its published lib has undeclared runtime
 * imports only the in-repo shell build provides.
 */
import { act } from 'react'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  fileExtension: (name: string) => name.split('.').at(-1) ?? '',
  FileTypeIcon: () => null,
  fileSizeText: (bytes: number) => `${bytes} B`,
  IconCheckOutlineRegular: () => createElement('span', { 'data-icon': 'check' }),
  IconCopyOutlineRegular: () => createElement('span', { 'data-icon': 'copy' }),
  JsonBlock: () => null,
  projectUserText: (text: string) => text,
  Tooltip: (props: { children?: ReactNode }) => createElement('span', {}, props.children),
  writeClipboard: async () => true,
}))

import { OmUserMessageNodeView, type RollbackInjected } from '../src/client/user-message.tsx'
import { en } from '../src/client/locales.ts'

declare global {
  // React 18 act environment flag.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const t = (key: string, params?: Record<string, string | number>): string =>
  (en as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? '')) ?? key

function mount(options: {
  dataSeq: number
  anchorSeq?: number
  turn?: number
  content?: readonly unknown[]
  injected: Partial<RollbackInjected>
}) {
  const injected: RollbackInjected = {
    rollbackWindow: () => ({ entries: [], hasMore: false }),
    rollback: () => {},
    notifyRollbackBlocked: () => {},
    ...options.injected,
  }
  act(() => {
    root.render(
      createElement(OmUserMessageNodeView, {
        node: {
          // Deliberately different from data.seq: the click must use the
          // durable event seq, not the flow-ordering anchorSeq.
          anchorSeq: options.anchorSeq ?? options.dataSeq + 1000,
          location: { kind: 'turn', turn: { turn: options.turn ?? 2 } },
          data: {
            seq: options.dataSeq,
            time: Date.parse('2026-01-15T14:30:00'),
            content: options.content ?? [{ type: 'text', text: 'restore me' }],
          },
        },
        renderMessageImages: () => null,
        openFile: () => {},
        openSkill: () => {},
        t,
        ...injected,
      } as never),
    )
  })
}

function rollbackButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${en['message.rollback']}"]`)
  if (!button) throw new Error('rollback button not rendered')
  return button
}

describe('OmUserMessageNodeView rollback click', () => {
  it('forks at the last turn/end before the durable message seq', () => {
    const calls: [number, string][] = []
    mount({
      dataSeq: 11,
      injected: {
        rollback: (anchor, text) => { calls.push([anchor, text]) },
        rollbackWindow: () => ({
          entries: [{ seq: 0, type: 'turn/start' }, { seq: 3, type: 'turn/end' }, { seq: 10, type: 'turn/start' }],
          hasMore: false,
        }),
      },
    })
    act(() => { rollbackButton().click() })
    expect(calls).toEqual([[3, 'restore me']])
  })

  it('notifies instead of forking when the window lacks the prefix', () => {
    const calls: unknown[] = []
    let blocked = 0
    mount({
      dataSeq: 41,
      injected: {
        rollback: (...args) => { calls.push(args) },
        notifyRollbackBlocked: () => { blocked += 1 },
        rollbackWindow: () => ({ entries: [{ seq: 20, type: 'turn/start' }], hasMore: true }),
      },
    })
    act(() => { rollbackButton().click() })
    expect(calls).toEqual([])
    expect(blocked).toBe(1)
  })

  it('forks even when older pages stay unloaded (tail-anchored window)', () => {
    // Regression: the window of any long session has hasMore=true; an anchor
    // inside the loaded tail must still resolve (no blocked notice).
    const calls: [number, string][] = []
    let blocked = 0
    mount({
      dataSeq: 61,
      injected: {
        rollback: (anchor, text) => { calls.push([anchor, text]) },
        notifyRollbackBlocked: () => { blocked += 1 },
        rollbackWindow: () => ({
          entries: [{ seq: 50, type: 'turn/start' }, { seq: 53, type: 'turn/end' }, { seq: 60, type: 'turn/start' }],
          hasMore: true,
        }),
      },
    })
    act(() => { rollbackButton().click() })
    expect(calls).toEqual([[53, 'restore me']])
    expect(blocked).toBe(0)
  })

  it('does not fire when disabled (first turn)', () => {
    const calls: unknown[] = []
    mount({ dataSeq: 1, turn: 0, injected: { rollback: (...args) => { calls.push(args) } } })
    expect(rollbackButton().getAttribute('aria-disabled')).toBe('true')
    act(() => { rollbackButton().click() })
    expect(calls).toEqual([])
  })
})
