/** Live bounded DOM coverage; collection/rendering never attest model projection. */
import { z } from 'zod'
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const observationId = z.string().regex(/^obs_[a-f0-9-]{36}$/)
export const contentObservationSchema = z.strictObject({
  version: z.literal(1), observationId, baseObservationId: observationId.optional(), kind: z.enum(['snapshot', 'delta']),
  observedAt: count, complete: z.literal(false), renderComplete: z.boolean(),
  textScope: z.enum(['main-text', 'region-text']), redaction: z.literal('recognized-sensitive-values'),
  omitted: z.strictObject({ mainCharacters: count, controls: count, fields: count, selectsWithOmittedOptions: count, openTreeLimited: z.boolean() }),
}).refine(value => value.kind === 'delta' ? value.baseObservationId !== undefined : value.baseObservationId === undefined)
export type ContentObservation = z.infer<typeof contentObservationSchema>
export const snapshotCoverageSchema = z.strictObject({
  version: z.literal(1), complete: z.literal(false), projection: z.literal('not-attested'), metadataAvailable: z.boolean(),
  range: z.enum(['listed-frames', 'selected-frame']),
  omittedFrames: count.nullable(),
  missing: z.array(z.enum(['closed-roots', 'canvas-image-layers', 'non-dom-state', 'unlisted-frames', 'frame-errors', 'frame-budget', 'legacy-metadata'])).max(7),
  frames: z.array(z.strictObject({ frameId: count, status: z.enum(['captured', 'unreadable', 'omitted-budget', 'metadata-unavailable']),
    documentEpoch: z.string().regex(/^doc_[a-f0-9-]{36}$/).optional(), observation: contentObservationSchema.optional(),
  }).refine(frame => frame.status !== 'captured' || frame.documentEpoch !== undefined && frame.observation !== undefined)).max(64),
}).refine(value => value.metadataAvailable ? value.omittedFrames !== null : value.omittedFrames === null && value.frames.length === 0)
export type SnapshotCoverage = z.infer<typeof snapshotCoverageSchema>
export function unknownSnapshotCoverage(): SnapshotCoverage {
  return { version: 1, complete: false, projection: 'not-attested', metadataAvailable: false, range: 'listed-frames', omittedFrames: null,
    frames: [], missing: ['closed-roots', 'canvas-image-layers', 'non-dom-state', 'legacy-metadata'] }
}
export function snapshotCoverageText(value: SnapshotCoverage): string {
  if (!value.metadataAvailable) return 'Observation coverage: unknown (legacy metadata unavailable); treat as partial. Model projection is not attested.'
  const known = value.frames.flatMap(frame => frame.observation ? [frame.observation] : [])
  const sum = (key: 'mainCharacters' | 'controls' | 'fields' | 'selectsWithOmittedOptions') => known.reduce((total, frame) => total + frame.omitted[key], 0)
  return `Observation coverage: partial (${value.range}). ${known.length}/${value.frames.length} frame metadata; ${value.omittedFrames} additional listed frames omitted. Collection omitted: ${sum('mainCharacters')} main characters, ${sum('controls')} controls, ${sum('fields')} fields, options from ${sum('selectsWithOmittedOptions')} selects. Render-clipped frames: ${known.filter(frame => !frame.renderComplete).length}; limited open trees: ${known.filter(frame => frame.omitted.openTreeLimited).length}. Closed roots, canvas layers, non-DOM state and unlisted frames are not covered. Model projection is not attested.`
}
