/**
 * Stride execution contract: identity, observation, action fact, run lifecycle,
 * error taxonomy and capability negotiation.
 *
 * These modules are the shared vocabulary the browser tools, the Host run
 * store, the extension executor and both entry points are meant to converge on.
 * They are additive to `../protocol.ts`: the current wire frames are unchanged
 * so the M0 baseline keeps working.
 *
 * @module
 */

export * from './ids.ts'
export * from './observation.ts'
export * from './outcome.ts'
export * from './errors.ts'
export * from './run.ts'
export * from './capabilities.ts'
