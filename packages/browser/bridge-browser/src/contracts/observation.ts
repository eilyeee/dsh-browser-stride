/**
 * Observation envelope: what the model is allowed to believe about a page.
 *
 * Text snapshots in the upstream extension are self-contained: a truncated
 * snapshot and a complete one look alike, and a delta names no base. Both are
 * fine for a one-turn prototype and both are silent-failure sources once an
 * action must be justified by "the page really is in this state": the model can
 * claim a form was saved from a snapshot that never contained the fields, or
 * apply a delta to a baseline another task replaced.
 *
 * This envelope makes coverage, baseline binding, redaction and image framing
 * explicit fields, validates their mutual consistency, and binds element
 * references to the observation that produced them. It carries no page content;
 * content stays in the existing snapshot renderer and in Host artifacts.
 *
 * The observation envelope is not yet wired into the runtime.
 *
 * @module
 */

import {
  type BrowserInstanceId,
  type DocumentId,
  type ElementRef,
  type FrameId,
  type ObservationId,
  type TabId,
  isElementRefOf,
} from './ids.ts'

/** How an observation represents page state. */
export type ObservationKind = 'snapshot' | 'delta' | 'text' | 'structured' | 'image'

/** The browser/tab/frame/document range an observation covers. */
export interface ObservationTarget {
  /** Browser instance observed. */
  browserInstanceId: BrowserInstanceId
  /** Tab observed. */
  tabId: TabId
  /** Frame observed. */
  frameId: FrameId
  /** Document observed; a reload or cross-document navigation changes it. */
  documentId: DocumentId
}

/** Viewport facts that make an image or coordinate actionable later. */
export interface ViewportSnapshot {
  /** Layout viewport width in CSS pixels. */
  width: number
  /** Layout viewport height in CSS pixels. */
  height: number
  /** Horizontal scroll offset at capture time. */
  scrollX: number
  /** Vertical scroll offset at capture time. */
  scrollY: number
  /** Browser zoom factor; 1 means 100%. */
  zoom: number
  /** Device pixel ratio used to convert image pixels to CSS pixels. */
  devicePixelRatio: number
}

/** How much of the requested range the observation actually covered. */
export interface ObservationCoverage {
  /** True only when the whole requested range was read. */
  complete: boolean
  /** True when a size or item budget cut the observation. */
  truncated: boolean
  /** Frames that were requested but could not be read. */
  unreadableFrameCount: number
  /** Human-readable reasons for anything missing, e.g. a closed shadow root. */
  missingReasons: readonly string[]
}

/** Image binding for a screenshot observation. */
export interface ImageBinding {
  /** Host artifact reference; never a bare path or inline base64. */
  artifactRef: string
  /** Image width in device pixels. */
  width: number
  /** Image height in device pixels. */
  height: number
  /** Viewport state at capture time. */
  viewport: ViewportSnapshot
  /** Crop rectangle in CSS pixels, relative to the viewport. */
  crop?: { x: number; y: number; width: number; height: number }
}

/** One observation. Immutable once issued. */
export interface Observation {
  /** Identity minted by the extension. */
  observationId: ObservationId
  /** Representation kind. */
  kind: ObservationKind
  /** Range covered. */
  target: ObservationTarget
  /** Capture time, epoch milliseconds. */
  observedAt: number
  /** For `delta` only: the full observation this delta extends. */
  baseObservationId?: ObservationId
  /** Coverage facts. */
  coverage: ObservationCoverage
  /** True when sensitive fields were masked before the observation left the page. */
  redacted: boolean
  /** Element references this observation issued, each bound to its id. */
  elementRefs?: readonly ElementRef[]
  /** Present for `image` observations. */
  image?: ImageBinding
  /** Present for `structured` observations: the schema the data conforms to. */
  schemaVersion?: string
}

/** Why an observation envelope is unusable. */
export type ObservationViolation =
  | 'invalid-timestamp'
  | 'delta-without-base'
  | 'non-delta-with-base'
  | 'coverage-inconsistent'
  | 'structured-without-schema'
  | 'image-without-window'
  | 'invalid-image'
  | 'image-crop-out-of-bounds'
  | 'foreign-element-ref'

/**
 * Validate an observation envelope.
 *
 * These rules are cheap and local on purpose: they must run on both sides of
 * the bridge, before an observation becomes evidence for a verified claim.
 *
 * @param observation - candidate observation.
 * @returns violations, empty when the envelope is internally consistent.
 */
export function validateObservation(observation: Observation): ObservationViolation[] {
  const violations: ObservationViolation[] = []
  if (!Number.isFinite(observation.observedAt) || observation.observedAt <= 0) {
    violations.push('invalid-timestamp')
  }
  if (observation.kind === 'delta' && observation.baseObservationId === undefined) {
    violations.push('delta-without-base')
  }
  if (observation.kind !== 'delta' && observation.baseObservationId !== undefined) {
    violations.push('non-delta-with-base')
  }
  const { complete, truncated, unreadableFrameCount, missingReasons } = observation.coverage
  if (complete && (truncated || unreadableFrameCount > 0 || missingReasons.length > 0)) {
    violations.push('coverage-inconsistent')
  }
  if (observation.kind === 'structured' && (observation.schemaVersion ?? '').trim() === '') {
    violations.push('structured-without-schema')
  }
  if (observation.kind === 'image') {
    if (observation.image === undefined) {
      violations.push('image-without-window')
    } else if (!isValidViewport(observation.image.viewport)) {
      violations.push('image-without-window')
    }
    if (observation.image !== undefined && (!Number.isSafeInteger(observation.image.width)
      || observation.image.width <= 0 || !Number.isSafeInteger(observation.image.height)
      || observation.image.height <= 0 || observation.image.artifactRef.trim() === '')) {
      violations.push('invalid-image')
    }
  }
  const crop = observation.image?.crop
  const viewport = observation.image?.viewport
  if (crop !== undefined && viewport !== undefined) {
    const within = crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
      && crop.x + crop.width <= viewport.width
      && crop.y + crop.height <= viewport.height
    if (!within) violations.push('image-crop-out-of-bounds')
  }
  for (const ref of observation.elementRefs ?? []) {
    if (!isElementRefOf(ref, observation.observationId)) violations.push('foreign-element-ref')
  }
  return violations
}

function isValidViewport(viewport: ViewportSnapshot): boolean {
  return Number.isFinite(viewport.width) && viewport.width > 0
    && Number.isFinite(viewport.height) && viewport.height > 0
    && Number.isFinite(viewport.zoom) && viewport.zoom > 0
    && Number.isFinite(viewport.devicePixelRatio) && viewport.devicePixelRatio > 0
    && Number.isFinite(viewport.scrollX) && Number.isFinite(viewport.scrollY)
}

/**
 * Can this observation support a claim that a whole range was seen?
 *
 * A partial or truncated observation can still justify an action on what it
 * did show, but it must never justify "the page has no errors" or "all rows
 * were exported".
 *
 * @param observation - candidate observation.
 * @returns true when coverage is complete and internally consistent.
 */
export function coversCompleteRange(observation: Observation): boolean {
  return observation.coverage.complete && validateObservation(observation).length === 0
}

/**
 * Is a delta still applicable?
 *
 * The contract forbids "the tab's most recent snapshot" as an implicit base: a
 * delta applies only to the baseline it names, and other runs' observations may
 * not substitute for it.
 *
 * @param delta - delta observation.
 * @param availableBaseIds - observation ids the caller still holds.
 * @returns true when the named base is available.
 */
export function canApplyDelta(delta: Observation, availableBaseIds: readonly ObservationId[]): boolean {
  if (delta.kind !== 'delta' || delta.baseObservationId === undefined) return false
  return availableBaseIds.includes(delta.baseObservationId)
}

/**
 * Convert image pixels to CSS pixels using the actual captured image dimensions.
 *
 * A screenshot is only coordinate-actionable together with its viewport:
 * scrolling, zooming or switching tabs invalidates the mapping, which is why
 * the conversion must use the captured values rather than the
 * current ones.
 *
 * @param observation - image observation.
 * @param imageX - x in device pixels.
 * @param imageY - y in device pixels.
 * @returns CSS-pixel coordinates plus viewport scroll, or `undefined` for an invalid or out-of-bounds point.
 */
export function imagePointToCss(
  observation: Observation,
  imageX: number,
  imageY: number,
): { x: number; y: number; scrollX: number; scrollY: number } | undefined {
  const image = observation.image
  if (observation.kind !== 'image' || image === undefined || validateObservation(observation).length > 0
    || !Number.isFinite(imageX) || !Number.isFinite(imageY)
    || imageX < 0 || imageX >= image.width || imageY < 0 || imageY >= image.height) return undefined
  const cropX = image.crop?.x ?? 0
  const cropY = image.crop?.y ?? 0
  const cssWidth = image.crop?.width ?? image.viewport.width
  const cssHeight = image.crop?.height ?? image.viewport.height
  return {
    x: cropX + imageX * cssWidth / image.width,
    y: cropY + imageY * cssHeight / image.height,
    scrollX: image.viewport.scrollX,
    scrollY: image.viewport.scrollY,
  }
}

/** Check the live target and viewport before reusing screenshot coordinates. */
export function isImageCurrent(observation: Observation, target: ObservationTarget, viewport: ViewportSnapshot): boolean {
  if (observation.kind !== 'image' || observation.image === undefined || validateObservation(observation).length > 0) return false
  const captured = observation.image.viewport
  return observation.target.browserInstanceId === target.browserInstanceId
    && observation.target.tabId === target.tabId
    && observation.target.frameId === target.frameId
    && observation.target.documentId === target.documentId
    && captured.width === viewport.width && captured.height === viewport.height
    && captured.scrollX === viewport.scrollX && captured.scrollY === viewport.scrollY
    && captured.zoom === viewport.zoom && captured.devicePixelRatio === viewport.devicePixelRatio
}
