/**
 * Render smoke tests for the rollback-enabled user bubble. The platform-shared
 * ui-primitives module is factory-mocked: its published lib carries undeclared
 * runtime imports (clsx, katex, …) only the in-repo shell build provides.
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  fileExtension: (name: string) => name.split('.').at(-1) ?? '',
  FileTypeIcon: () => null,
  fileSizeText: (bytes: number) => `${bytes} B`,
  IconCheckOutlineRegular: () => createElement('span', { 'data-icon': 'check' }),
  IconCopyOutlineRegular: () => createElement('span', { 'data-icon': 'copy' }),
  JsonBlock: () => null,
  projectUserText: (text: string) => text,
  Tooltip: (props: { children?: ReactNode }) => createElement(Fragment_ => props.children, null),
  writeClipboard: async () => true,
}))

import { OmUserMessageNodeView } from '../src/client/user-message.tsx'
import { en, zh } from '../src/client/locales.ts'

function node(overrides: { seq?: number; turn?: number; content?: readonly unknown[] } = {}) {
  return {
    anchorSeq: overrides.seq ?? 11,
    location: { kind: 'turn', turn: { turn: overrides.turn ?? 1 } },
    data: {
      seq: overrides.seq ?? 11,
      time: Date.parse('2026-01-15T14:30:00'),
      content: overrides.content ?? [{ type: 'text', text: 'remember the codename' }],
    },
  }
}

function render(options: {
  n?: ReturnType<typeof node>
  locale?: Record<string, string>
  rollbackWindow?: () => { entries: { seq: number; type: string }[]; hasMore: boolean }
  rollback?: (anchor: number, text: string) => void
  notifyRollbackBlocked?: () => void
}) {
  const locale = options.locale ?? (en as Record<string, string>)
  return renderToStaticMarkup(
    createElement(OmUserMessageNodeView, {
      node: options.n ?? node(),
      renderMessageImages: () => null,
      openFile: () => {},
      openSkill: () => {},
      t: (key: string, params?: Record<string, string | number>) => {
        const template = locale[key] ?? key
        return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
      },
      rollbackWindow: options.rollbackWindow ?? (() => ({ entries: [{ seq: 3, type: 'turn/end' }], hasMore: false })),
      rollback: options.rollback ?? (() => {}),
      notifyRollbackBlocked: options.notifyRollbackBlocked ?? (() => {}),
    } as never),
  )
}

describe('OmUserMessageNodeView', () => {
  it('renders the bubble with rollback and copy actions', () => {
    const html = render({})
    expect(html).toContain('remember the codename')
    expect(html).toContain('Rollback')
    expect(html).toContain('Copy')
  })

  it('renders Chinese copy from the zh dictionary', () => {
    const html = render({ locale: zh as Record<string, string> })
    expect(html).toContain('回退')
  })

  it('disables rollback for first-turn messages', () => {
    const html = render({ n: node({ turn: 0, seq: 1 }) })
    expect(html).toContain('data-unavailable')
    expect(html).toContain('Only text-only messages past the first turn can roll back')
  })

  it('disables rollback for attachment-bearing or textless messages', () => {
    const html = render({ n: node({ content: [{ type: 'image', attachment: { ref: 'a' } }] }) })
    expect(html).toContain('data-unavailable')
  })
})
