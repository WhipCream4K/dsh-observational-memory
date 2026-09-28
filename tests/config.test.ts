import { describe, expect, it } from 'vitest'
import {
  resolveCompactAfterTokens,
  resolveConfig,
  resolveObservationsPoolTargetTokens,
  resolveObserverChunkMaxTokens,
  Config,
} from '../src/config.ts'

describe('Config schema', () => {
  it('resolves defaults for an empty composition entry', () => {
    // Config() now parses volatile fields into Loader-owned references;
    // resolveConfig is the plain resolved shape the runtime consumes.
    const config = resolveConfig({})
    expect(config.observeAfterTokens).toBe(10_000)
    expect(config.reflectAfterTokens).toBe(20_000)
    expect(config.compactAfterTokens).toBe(0)
    expect(config.compactAfterTokensMode).toBe('calibrated')
    expect(config.compactAfterTokensRatio).toBe(0.68)
    expect(config.observationsPoolMaxTokens).toBe(20_000)
    expect(config.agentMaxTurns).toBe(16)
    expect(config.passive).toBe(false)
    expect(config.debugLog).toBe(false)
    expect(config.showWorkerNotifications).toBe(true)
  })

  it('keeps user values', () => {
    const config = resolveConfig({ observeAfterTokens: 5000, passive: true, model: { provider: 'p', id: 'm' } })
    expect(config.observeAfterTokens).toBe(5000)
    expect(config.passive).toBe(true)
    expect(config.model).toEqual({ provider: 'p', id: 'm' })
  })
})

describe('resolveObserverChunkMaxTokens', () => {
  const base = resolveConfig({})

  it('honors an explicit config value (clamped to the minimum)', () => {
    expect(resolveObserverChunkMaxTokens(resolveConfig({ observerChunkMaxTokens: 5000 }), 1_000_000)).toBe(5000)
    expect(resolveObserverChunkMaxTokens(resolveConfig({ observerChunkMaxTokens: 256 }), 1_000_000)).toBe(256)
  })

  it('derives from the model context window and floors at the minimum', () => {
    expect(resolveObserverChunkMaxTokens(base, 1_000_000)).toBe(200_000)
    expect(resolveObserverChunkMaxTokens(base, 1000)).toBe(256)
  })

  it('falls back when the window is unknown or invalid', () => {
    expect(resolveObserverChunkMaxTokens(base, undefined)).toBe(60_000)
    expect(resolveObserverChunkMaxTokens(base, 0)).toBe(60_000)
    expect(resolveObserverChunkMaxTokens(base, -5)).toBe(60_000)
  })
})

describe('resolveCompactAfterTokens', () => {
  it('returns the static threshold in calibrated mode', () => {
    const config = resolveConfig({ compactAfterTokens: 81_000 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81_000)
    expect(resolveCompactAfterTokens(config, undefined)).toBe(81_000)
  })

  it('derives from the context window in ratio mode', () => {
    const config = resolveConfig({ compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.68 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(680_000)
    expect(resolveCompactAfterTokens(config, 128_000)).toBe(87_040)
  })

  it('derives a positive threshold even when the static value is 0', () => {
    const config = resolveConfig({ compactAfterTokens: 0, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.5 })
    expect(resolveCompactAfterTokens(config, 100)).toBe(50)
    expect(resolveCompactAfterTokens(config, 1)).toBe(1)
  })

  it('disables the trigger when the window is unknown or invalid in ratio mode', () => {
    // compactAfterTokens is inert in ratio mode: there is no calibrated fallback.
    const config = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio' })
    expect(resolveCompactAfterTokens(config, undefined)).toBe(0)
    expect(resolveCompactAfterTokens(config, 0)).toBe(0)
    expect(resolveCompactAfterTokens(config, -5)).toBe(0)
  })

  it('disables the trigger for endpoint ratios the schema admits', () => {
    const zero = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0 })
    const one = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 1 })
    expect(resolveCompactAfterTokens(zero, 1_000_000)).toBe(0)
    expect(resolveCompactAfterTokens(one, 1_000_000)).toBe(0)
  })

  it('ignores the ratio in calibrated mode', () => {
    const config = resolveConfig({ compactAfterTokens: 81_000, compactAfterTokensRatio: 0.5 })
    expect(resolveCompactAfterTokens(config, 1_000_000)).toBe(81_000)
    expect(resolveCompactAfterTokens(config, undefined)).toBe(81_000)
  })

  it('rejects out-of-range ratios at the schema boundary', () => {
    expect(() => Config({ compactAfterTokensRatio: -0.1 })).toThrow()
    expect(() => Config({ compactAfterTokensRatio: 1.5 })).toThrow()
  })

  it('rejects an unknown mode at the schema boundary', () => {
    expect(() => Config({ compactAfterTokensMode: 'windowed' as never })).toThrow()
  })
})

describe('resolveObservationsPoolTargetTokens', () => {
  it('defaults to half of the pool max', () => {
    expect(resolveObservationsPoolTargetTokens(resolveConfig({}))).toBe(10_000)
    expect(resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000 }))).toBe(1500)
  })

  it('honors a valid explicit target and rejects invalid ones', () => {
    expect(
      resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000, observationsPoolTargetTokens: 1000 })),
    ).toBe(1000)
    expect(
      resolveObservationsPoolTargetTokens(resolveConfig({ observationsPoolMaxTokens: 3000, observationsPoolTargetTokens: 9000 })),
    ).toBe(1500)
  })
})
