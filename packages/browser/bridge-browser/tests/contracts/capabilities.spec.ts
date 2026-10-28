import { describe, expect, it } from 'vitest'
import {
  BROWSER_CAPABILITIES,
  CDP_FLAT_SESSION_CHROME_FLOOR,
  STRIDE_PROTOCOL_SUPPORT,
  applyChromeVersion,
  applyRuntimeConditions,
  capabilitiesNeedingUser,
  isCapabilityReady,
  negotiateCapabilities,
  negotiateProtocol,
  readyCapabilities,
  type CapabilityLayers,
  type CapabilityReport,
  type BrowserCapability,
} from '../../src/contracts/capabilities.ts'

const ALL: readonly BrowserCapability[] = BROWSER_CAPABILITIES

function layers(overrides: Partial<CapabilityLayers> = {}): CapabilityLayers {
  return { host: ALL, extension: ALL, model: ALL, task: ALL, ...overrides }
}

describe('negotiateCapabilities', () => {
  it('declares every capability ready when all layers agree', () => {
    const report = negotiateCapabilities(layers())
    expect(readyCapabilities(report)).toEqual(ALL)
    expect(capabilitiesNeedingUser(report)).toEqual([])
  })

  it('names the layer that withholds a capability', () => {
    const report = negotiateCapabilities(layers({ model: ALL.filter(capability => capability !== 'vision.screenshot') }))
    expect(report['vision.screenshot']).toEqual({ state: 'unsupported', reasons: ['missing-model'] })
    expect(isCapabilityReady(report, 'vision.screenshot')).toBe(false)
    expect(isCapabilityReady(report, 'page.snapshot')).toBe(true)
  })

  it('reports every missing layer at once', () => {
    const report = negotiateCapabilities(layers({
      host: ALL.filter(capability => capability !== 'file.upload'),
      task: ALL.filter(capability => capability !== 'file.upload'),
    }))
    expect(report['file.upload']).toEqual({ state: 'unsupported', reasons: ['missing-host', 'missing-authorization'] })
  })
})

describe('applyRuntimeConditions', () => {
  it('degrades a ready capability with a reason and does not mutate the input', () => {
    const report = negotiateCapabilities(layers())
    const next = applyRuntimeConditions(report, [
      { capability: 'vision.screenshot', state: 'requires_user_action', reason: 'focus-required' },
    ])
    expect(next['vision.screenshot']).toEqual({ state: 'requires_user_action', reasons: ['focus-required'] })
    expect(report['vision.screenshot']).toEqual({ state: 'ready' })
    expect(capabilitiesNeedingUser(next)).toEqual(['vision.screenshot'])
  })

  it('never promotes an unsupported capability', () => {
    const report = negotiateCapabilities(layers({ extension: ALL.filter(capability => capability !== 'input.keys') }))
    const next = applyRuntimeConditions(report, [
      { capability: 'input.keys', state: 'ready' as never, reason: 'debugger-busy' },
    ])
    expect(next['input.keys'].state).toBe('unsupported')
    expect(next['input.keys'].reasons).toContain('missing-extension')
  })

  it('accumulates distinct reasons', () => {
    const report = negotiateCapabilities(layers())
    const next = applyRuntimeConditions(report, [
      { capability: 'file.upload', state: 'temporarily_unavailable', reason: 'connection-down' },
      { capability: 'file.upload', state: 'temporarily_unavailable', reason: 'login-required' },
      { capability: 'file.upload', state: 'temporarily_unavailable', reason: 'login-required' },
    ])
    expect(next['file.upload'].reasons).toEqual(['connection-down', 'login-required'])
  })
})

describe('applyChromeVersion', () => {
  function chromeAwareReport(): CapabilityReport {
    return negotiateCapabilities(layers())
  }

  it('degrades CDP capabilities below the flat-session floor', () => {
    const report = applyChromeVersion(chromeAwareReport(), CDP_FLAT_SESSION_CHROME_FLOOR - 1)
    expect(report['vision.screenshot'].state).toBe('unsupported')
    expect(report['vision.screenshot'].reasons).toContain('chrome-version')
    expect(report['page.snapshot'].state).toBe('ready')
    expect(report['task.schedule'].state).toBe('ready')
  })

  it('leaves the report unchanged at or above the floor, or when the version is unknown', () => {
    expect(applyChromeVersion(chromeAwareReport(), CDP_FLAT_SESSION_CHROME_FLOOR)['vision.screenshot'].state).toBe('ready')
    expect(applyChromeVersion(chromeAwareReport(), 156)['vision.screenshot'].state).toBe('ready')
    expect(applyChromeVersion(chromeAwareReport(), undefined)['vision.screenshot'].state).toBe('ready')
  })
})

describe('negotiateProtocol', () => {
  it('agrees on the highest shared version', () => {
    expect(negotiateProtocol({ min: 1, max: 2 }, { min: 1, max: 3 })).toEqual({ ok: true, version: 2 })
    expect(negotiateProtocol(STRIDE_PROTOCOL_SUPPORT, STRIDE_PROTOCOL_SUPPORT)).toEqual({ ok: true, version: 1 })
  })

  it('names the older side when versions do not overlap', () => {
    const extensionBehind = negotiateProtocol({ min: 2, max: 3 }, { min: 1, max: 1 })
    expect(extensionBehind).toMatchObject({ ok: false, upgrade: 'extension' })
    const hostBehind = negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 3 })
    expect(hostBehind).toMatchObject({ ok: false, upgrade: 'host' })
    if (!extensionBehind.ok) expect(extensionBehind.message).toContain('no protocol overlap')
  })
})
