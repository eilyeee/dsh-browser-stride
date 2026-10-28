import { describe, expect, it } from 'vitest'
import {
  asActionId,
  asBrowserInstanceId,
  asConnectionEpoch,
  asControlRevision,
  asDocumentId,
  asFrameId,
  asObservationId,
  asRunId,
  asSessionId,
  asTabId,
  canonicalize,
  computeRequestDigest,
  isElementRefOf,
  makeElementRef,
  parseElementRef,
  validateTargetScope,
  type ActionDigestMaterial,
  type TargetObservation,
  type TargetScope,
} from '../../src/contracts/index.ts'

describe('branded ids', () => {
  it('rejects empty and whitespace-only string ids', () => {
    expect(() => asRunId('')).toThrow(TypeError)
    expect(() => asRunId('   ')).toThrow(TypeError)
    expect(asRunId(' run-1 ')).toBe('run-1')
  })

  it('rejects overlong ids', () => {
    expect(() => asSessionId('s'.repeat(201))).toThrow(TypeError)
  })

  it('validates numeric ids and their minimums', () => {
    expect(asControlRevision(0)).toBe(0)
    expect(() => asControlRevision(-1)).toThrow(TypeError)
    expect(() => asControlRevision(1.5)).toThrow(TypeError)
    expect(() => asConnectionEpoch(0)).toThrow(TypeError)
    expect(asConnectionEpoch(1)).toBe(1)
    expect(asFrameId(0)).toBe(0)
    expect(asTabId(12)).toBe(12)
  })
})

describe('element references', () => {
  const observationId = asObservationId('obs-1')

  it('binds a reference to its observation', () => {
    const ref = makeElementRef(observationId, 3)
    expect(ref).toBe('obs-1:3')
    expect(parseElementRef(ref)).toEqual({ observationId, index: 3 })
    expect(isElementRefOf(ref, observationId)).toBe(true)
    expect(isElementRefOf(ref, asObservationId('obs-2'))).toBe(false)
  })

  it('rejects bare indexes and malformed references', () => {
    expect(parseElementRef('3')).toBeUndefined()
    expect(parseElementRef('obs-1')).toBeUndefined()
    expect(parseElementRef('obs-1:x')).toBeUndefined()
    expect(parseElementRef('obs-1:-2')).toBeUndefined()
    expect(parseElementRef(`${'x'.repeat(201)}:1`)).toBeUndefined()
    expect(parseElementRef(' obs-1:1')).toBeUndefined()
  })

  it('rejects negative indexes at construction', () => {
    expect(() => makeElementRef(observationId, -1)).toThrow(TypeError)
  })
})

describe('canonicalize', () => {
  it('is independent of object key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('omits undefined members and preserves array order', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalize([2, 1])).toBe('[2,1]')
  })

  it('rejects values that cannot round-trip deterministically', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(() => canonicalize({ d: new Date(0) })).toThrow(TypeError)
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalize(cyclic)).toThrow(TypeError)
  })
})

function digestMaterial(): ActionDigestMaterial {
  return {
    actionId: asActionId('act-1'),
    browserInstanceId: asBrowserInstanceId('instance-1'),
    tabId: asTabId(7),
    frameId: asFrameId(0),
    documentId: asDocumentId('doc-1'),
    controlRevision: asControlRevision(2),
    name: 'browser_click',
    args: { index: 4, text: 'save' },
    beforeObservationId: asObservationId('obs-1'),
  }
}

describe('computeRequestDigest', () => {
  it('is stable across argument key order', async () => {
    const base = await computeRequestDigest(digestMaterial())
    const reordered = await computeRequestDigest({ ...digestMaterial(), args: { text: 'save', index: 4 } })
    expect(reordered).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the control revision, target or arguments change', async () => {
    const base = await computeRequestDigest(digestMaterial())
    const revision = await computeRequestDigest({ ...digestMaterial(), controlRevision: asControlRevision(3) })
    const target = await computeRequestDigest({ ...digestMaterial(), tabId: asTabId(8) })
    const args = await computeRequestDigest({ ...digestMaterial(), args: { index: 4, text: 'delete' } })
    const observation = await computeRequestDigest({ ...digestMaterial(), beforeObservationId: asObservationId('obs-2') })
    for (const digest of [revision, target, args, observation]) expect(digest).not.toBe(base)
  })
})

function scope(): TargetScope {
  return {
    browserInstanceId: asBrowserInstanceId('instance-1'),
    connectionEpoch: asConnectionEpoch(3),
    sessionId: asSessionId('session-1'),
    runId: asRunId('run-1'),
    controlRevision: asControlRevision(2),
    tabId: asTabId(7),
    allowedTabIds: [asTabId(7), asTabId(9)],
    frameId: asFrameId(0),
    documentId: asDocumentId('doc-1'),
  }
}

function observed(): TargetObservation {
  return {
    browserInstanceId: asBrowserInstanceId('instance-1'),
    connectionEpoch: asConnectionEpoch(3),
    controlRevision: asControlRevision(2),
    tabId: asTabId(7),
    frameId: asFrameId(0),
    documentId: asDocumentId('doc-1'),
  }
}

describe('validateTargetScope', () => {
  it('accepts the bound target', () => {
    expect(validateTargetScope(scope(), observed())).toEqual([])
  })

  it('reports every drifted layer', () => {
    expect(validateTargetScope(scope(), { ...observed(), browserInstanceId: asBrowserInstanceId('instance-2') }))
      .toEqual(['instance-mismatch'])
    expect(validateTargetScope(scope(), { ...observed(), connectionEpoch: asConnectionEpoch(2) }))
      .toEqual(['stale-epoch'])
    expect(validateTargetScope(scope(), { ...observed(), controlRevision: asControlRevision(1) }))
      .toEqual(['stale-control-revision'])
    expect(validateTargetScope(scope(), { ...observed(), documentId: asDocumentId('doc-2') }))
      .toEqual(['document-mismatch'])
    expect(validateTargetScope(scope(), { ...observed(), frameId: asFrameId(1) }))
      .toEqual(['frame-mismatch'])
  })

  it('rejects a tab outside the allowed set', () => {
    expect(validateTargetScope(scope(), { ...observed(), tabId: asTabId(11) }))
      .toEqual(['tab-not-allowed'])
  })
})
