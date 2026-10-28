import { describe, expect, it } from 'vitest'
import {
  asBrowserInstanceId,
  asDocumentId,
  asFrameId,
  asObservationId,
  asTabId,
  makeElementRef,
  type ElementRef,
} from '../../src/contracts/index.ts'
import {
  canApplyDelta,
  coversCompleteRange,
  imagePointToCss,
  isImageCurrent,
  validateObservation,
  type Observation,
  type ObservationCoverage,
} from '../../src/contracts/observation.ts'

const observationId = asObservationId('obs-1')

function coverage(overrides: Partial<ObservationCoverage> = {}): ObservationCoverage {
  return { complete: true, truncated: false, unreadableFrameCount: 0, missingReasons: [], ...overrides }
}

function snapshot(overrides: Partial<Observation> = {}): Observation {
  return {
    observationId,
    kind: 'snapshot',
    target: {
      browserInstanceId: asBrowserInstanceId('instance-1'),
      tabId: asTabId(7),
      frameId: asFrameId(0),
      documentId: asDocumentId('doc-1'),
    },
    observedAt: 1_700_000_000_000,
    coverage: coverage(),
    redacted: true,
    elementRefs: [makeElementRef(observationId, 0), makeElementRef(observationId, 1)],
    ...overrides,
  }
}

describe('validateObservation', () => {
  it('accepts a complete snapshot with bound element references', () => {
    expect(validateObservation(snapshot())).toEqual([])
  })

  it('requires a delta to name its base and forbids a base elsewhere', () => {
    expect(validateObservation(snapshot({ kind: 'delta' }))).toContain('delta-without-base')
    const delta = snapshot({ kind: 'delta', baseObservationId: asObservationId('obs-0') })
    expect(validateObservation(delta)).not.toContain('delta-without-base')
    expect(validateObservation(snapshot({ baseObservationId: asObservationId('obs-0') })))
      .toContain('non-delta-with-base')
  })

  it('rejects a claim of completeness that contradicts its own coverage', () => {
    expect(validateObservation(snapshot({ coverage: coverage({ truncated: true }) })))
      .toContain('coverage-inconsistent')
    expect(validateObservation(snapshot({ coverage: coverage({ unreadableFrameCount: 1 }) })))
      .toContain('coverage-inconsistent')
    expect(validateObservation(snapshot({ coverage: coverage({ missingReasons: ['closed shadow root'] }) })))
      .toContain('coverage-inconsistent')
  })

  it('requires a schema version for structured data', () => {
    expect(validateObservation(snapshot({ kind: 'structured' }))).toContain('structured-without-schema')
    expect(validateObservation(snapshot({ kind: 'structured', schemaVersion: 'order-v1' }))).toEqual([])
  })

  it('rejects image observations without viewport facts', () => {
    expect(validateObservation(snapshot({ kind: 'image' }))).toContain('image-without-window')
  })

  it('rejects a crop outside the viewport', () => {
    const image = snapshot({
      kind: 'image',
      image: {
        artifactRef: 'artifact-1',
        width: 1600,
        height: 1200,
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 120, zoom: 1, devicePixelRatio: 2 },
        crop: { x: 700, y: 0, width: 200, height: 100 },
      },
    })
    expect(validateObservation(image)).toContain('image-crop-out-of-bounds')
    const inBounds = {
      ...image,
      image: { ...image.image!, crop: { x: 100, y: 50, width: 200, height: 100 } },
    }
    expect(validateObservation(inBounds)).toEqual([])
  })

  it('rejects an invalid timestamp', () => {
    expect(validateObservation(snapshot({ observedAt: 0 }))).toEqual(['invalid-timestamp'])
  })

  it('rejects an element reference minted by a different observation', () => {
    const foreign: ElementRef = makeElementRef(asObservationId('obs-2'), 0)
    expect(validateObservation(snapshot({ elementRefs: [foreign] }))).toEqual(['foreign-element-ref'])
  })
})

describe('coverage helpers', () => {
  it('only lets a consistent complete observation claim a complete range', () => {
    expect(coversCompleteRange(snapshot())).toBe(true)
    expect(coversCompleteRange(snapshot({ coverage: coverage({ complete: false }) }))).toBe(false)
    expect(coversCompleteRange(snapshot({ coverage: coverage({ truncated: true }) }))).toBe(false)
  })

  it('applies a delta only to the baseline it names', () => {
    const delta = snapshot({ kind: 'delta', baseObservationId: asObservationId('obs-0') })
    expect(canApplyDelta(delta, [asObservationId('obs-0')])).toBe(true)
    expect(canApplyDelta(delta, [asObservationId('obs-9')])).toBe(false)
    expect(canApplyDelta(snapshot(), [asObservationId('obs-0')])).toBe(false)
  })
})

describe('imagePointToCss', () => {
  const image = snapshot({
    kind: 'image',
    image: {
      artifactRef: 'artifact-1',
      width: 400,
      height: 200,
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 120, zoom: 1, devicePixelRatio: 2 },
      crop: { x: 100, y: 50, width: 200, height: 100 },
    },
  })

  it('converts device pixels using captured DPR, zoom and crop', () => {
    expect(imagePointToCss(image, 40, 20)).toEqual({ x: 120, y: 60, scrollX: 0, scrollY: 120 })
  })

  it('uses the image dimensions when the screenshot was resized', () => {
    const resized = {
      ...image,
      image: { ...image.image!, width: 200, height: 100 },
    }
    expect(imagePointToCss(resized, 40, 20)).toEqual({ x: 140, y: 70, scrollX: 0, scrollY: 120 })
  })

  it('refuses invalid images and coordinates outside the captured image', () => {
    const invalid = { ...image, image: { ...image.image!, artifactRef: '', width: 0 } }
    expect(validateObservation(invalid)).toContain('invalid-image')
    expect(imagePointToCss(invalid, 0, 0)).toBeUndefined()
    expect(imagePointToCss(image, -1, 0)).toBeUndefined()
    expect(imagePointToCss(image, 400, 0)).toBeUndefined()
    expect(imagePointToCss(image, 0, Number.NaN)).toBeUndefined()
  })

  it('rejects a coordinate binding after navigation, scrolling or zooming', () => {
    const viewport = image.image!.viewport
    expect(isImageCurrent(image, image.target, viewport)).toBe(true)
    expect(isImageCurrent(image, { ...image.target, documentId: asDocumentId('new-doc') }, viewport)).toBe(false)
    expect(isImageCurrent(image, image.target, { ...viewport, scrollY: viewport.scrollY + 1 })).toBe(false)
    expect(isImageCurrent(image, image.target, { ...viewport, zoom: 2 })).toBe(false)
  })

  it('refuses a non-image observation', () => {
    expect(imagePointToCss(snapshot(), 10, 10)).toBeUndefined()
  })
})
