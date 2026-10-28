/**
 * Capability negotiation: what this host, this extension, this model and this
 * task are jointly allowed to do right now.
 *
 * The upstream handshake advertises three fixed bounds (`textOnly`,
 * `snapshotMaxChars`, `maxInteractiveItems`). This contract adds more: a
 * capability is available only when every layer offers it, its state must
 * distinguish "not built" from "waiting for the user" from "temporarily
 * blocked", and it must be re-checked before execution because permissions,
 * focus, debugger attachment and the selected model change during a session.
 *
 * The representation therefore has two stages: a static intersection of the
 * declared layers, then runtime conditions that may only degrade the result.
 * That asymmetry is deliberate — no runtime event can promote a capability the
 * product never declared.
 *
 * These rules are not yet wired into the runtime.
 *
 * @module
 */

/** Capabilities the product can negotiate. */
export type BrowserCapability =
  | 'page.snapshot'
  | 'page.frames'
  | 'page.shadow-dom'
  | 'action.click'
  | 'action.type'
  | 'action.select'
  | 'action.checkbox'
  | 'action.scroll'
  | 'action.navigate'
  | 'input.keys'
  | 'input.pointer'
  | 'input.clipboard'
  | 'vision.screenshot'
  | 'vision.region-select'
  | 'diagnostics.console'
  | 'diagnostics.network'
  | 'diagnostics.dom'
  | 'file.upload'
  | 'file.download'
  | 'dialog.native'
  | 'extract.structured'
  | 'task.template'
  | 'task.recording'
  | 'task.schedule'

/** Every capability, in declaration order. */
export const BROWSER_CAPABILITIES: readonly BrowserCapability[] = [
  'page.snapshot',
  'page.frames',
  'page.shadow-dom',
  'action.click',
  'action.type',
  'action.select',
  'action.checkbox',
  'action.scroll',
  'action.navigate',
  'input.keys',
  'input.pointer',
  'input.clipboard',
  'vision.screenshot',
  'vision.region-select',
  'diagnostics.console',
  'diagnostics.network',
  'diagnostics.dom',
  'file.upload',
  'file.download',
  'dialog.native',
  'extract.structured',
  'task.template',
  'task.recording',
  'task.schedule',
]

/** Negotiation states. Only `ready` permits a tool call to proceed. */
export type CapabilityState = 'ready' | 'unsupported' | 'temporarily_unavailable' | 'requires_user_action'

/** Machine reason a capability is not ready. */
export type CapabilityReason =
  | 'missing-host'
  | 'missing-extension'
  | 'missing-model'
  | 'missing-authorization'
  | 'protocol-incompatible'
  | 'chrome-version'
  | 'connection-down'
  | 'focus-required'
  | 'page-type-unsupported'
  | 'debugger-busy'
  | 'permission-required'
  | 'login-required'
  | 'budget-exhausted'

/** One capability's negotiated status. */
export interface CapabilityStatus {
  /** Negotiated state. */
  state: CapabilityState
  /** Why it is not ready; absent when ready. */
  reasons?: readonly CapabilityReason[]
}

/** Status for every known capability. */
export type CapabilityReport = Readonly<Record<BrowserCapability, CapabilityStatus>>

/** The four declaration layers a capability must survive. */
export interface CapabilityLayers {
  /** Capabilities the host build supports. */
  host: readonly BrowserCapability[]
  /** Capabilities the installed extension build supports. */
  extension: readonly BrowserCapability[]
  /** Capabilities the selected provider/model adapter can express (e.g. image input). */
  model: readonly BrowserCapability[]
  /** Capabilities the task definition is authorized to use. */
  task: readonly BrowserCapability[]
}

/**
 * Intersect the declared layers.
 *
 * Each missing layer is reported by name so the UI can say "the model cannot
 * see images" rather than "screenshot unavailable".
 *
 * @param layers - declarations from host, extension, model and task.
 * @returns a status for every capability.
 */
export function negotiateCapabilities(layers: CapabilityLayers): CapabilityReport {
  const host = new Set(layers.host)
  const extension = new Set(layers.extension)
  const model = new Set(layers.model)
  const task = new Set(layers.task)
  const report = {} as Record<BrowserCapability, CapabilityStatus>
  for (const capability of BROWSER_CAPABILITIES) {
    const reasons: CapabilityReason[] = []
    if (!host.has(capability)) reasons.push('missing-host')
    if (!extension.has(capability)) reasons.push('missing-extension')
    if (!model.has(capability)) reasons.push('missing-model')
    if (!task.has(capability)) reasons.push('missing-authorization')
    report[capability] = reasons.length === 0 ? { state: 'ready' } : { state: 'unsupported', reasons }
  }
  return report
}

/** A runtime fact that degrades one capability after negotiation. */
export interface RuntimeCondition {
  /** Capability affected. */
  capability: BrowserCapability
  /** Degraded state, never `ready`. */
  state: Exclude<CapabilityState, 'ready'>
  /** Why. */
  reason: CapabilityReason
}

/**
 * Apply runtime conditions to a negotiated report.
 *
 * Conditions may only degrade; a capability that is already unsupported keeps
 * its static reasons so the operator can see the real cause. Repeated
 * conditions on one capability accumulate distinct reasons.
 *
 * @param report - negotiated report.
 * @param conditions - current runtime facts.
 * @returns a new report; the input is not mutated.
 */
export function applyRuntimeConditions(
  report: CapabilityReport,
  conditions: readonly RuntimeCondition[],
): CapabilityReport {
  const next = { ...report } as Record<BrowserCapability, CapabilityStatus>
  for (const condition of conditions) {
    const current = next[condition.capability]
    if (current.state === 'unsupported') continue
    const reasons = [...new Set([...(current.reasons ?? []), condition.reason])]
    next[condition.capability] = { state: condition.state, reasons }
  }
  return next
}

/**
 * Is this capability ready to be used right now?
 * @param report - current report.
 * @param capability - capability to check.
 * @returns true only for `ready`.
 */
export function isCapabilityReady(report: CapabilityReport, capability: BrowserCapability): boolean {
  return report[capability].state === 'ready'
}

/**
 * Capabilities currently ready, for tool catalog and UI.
 * @param report - current report.
 * @returns ready capability ids in declaration order.
 */
export function readyCapabilities(report: CapabilityReport): readonly BrowserCapability[] {
  return BROWSER_CAPABILITIES.filter(capability => report[capability].state === 'ready')
}

/**
 * Capabilities that need a user decision, for the "requires your action" panel.
 * @param report - current report.
 * @returns capabilities in `requires_user_action`.
 */
export function capabilitiesNeedingUser(report: CapabilityReport): readonly BrowserCapability[] {
  return BROWSER_CAPABILITIES.filter(capability => report[capability].state === 'requires_user_action')
}

/** Capabilities that depend on the Chrome debugger (CDP). */
const CDP_CAPABILITIES: readonly BrowserCapability[] = [
  'input.keys',
  'input.pointer',
  'input.clipboard',
  'vision.screenshot',
  'diagnostics.console',
  'diagnostics.network',
  'diagnostics.dom',
  'dialog.native',
  'file.upload',
]

/** Chrome version that introduced flat child sessions, the design floor for shared CDP. */
export const CDP_FLAT_SESSION_CHROME_FLOOR = 125

/**
 * Degrade CDP-dependent capabilities on browsers older than the design floor.
 *
 * The manifest still allows Chrome 116 for the text path; that is a different
 * promise. Only capabilities that need flat child sessions are degraded here,
 * 125 is not a universal CDP minimum.
 *
 * @param report - negotiated report.
 * @param chromeMajor - detected major version, or `undefined` when unknown.
 * @returns a new report.
 */
export function applyChromeVersion(report: CapabilityReport, chromeMajor: number | undefined): CapabilityReport {
  if (chromeMajor === undefined || chromeMajor >= CDP_FLAT_SESSION_CHROME_FLOOR) return report
  return applyRuntimeConditions(report, CDP_CAPABILITIES.map(capability => ({
    capability,
    state: 'unsupported' as const,
    reason: 'chrome-version' as const,
  })))
}

/** Half-open range of protocol versions a side supports. */
export interface ProtocolSupport {
  /** Lowest supported version. */
  min: number
  /** Highest supported version. */
  max: number
}

/** The version this build speaks. */
export const STRIDE_PROTOCOL_SUPPORT: ProtocolSupport = { min: 1, max: 1 }

/** Result of a version negotiation. */
export type ProtocolNegotiation =
  | { ok: true; version: number }
  | { ok: false; reason: 'no-overlap'; local: ProtocolSupport; remote: ProtocolSupport; upgrade: 'host' | 'extension' | 'undetermined'; message: string }

/**
 * Negotiate the highest protocol version both sides support.
 *
 * A failed negotiation must name which side is behind, providing an
 * actionable upgrade direction instead of a generic refusal.
 *
 * @param local - this build's range.
 * @param remote - peer's range.
 * @returns the agreed version or a refusal with an upgrade direction.
 */
export function negotiateProtocol(local: ProtocolSupport, remote: ProtocolSupport): ProtocolNegotiation {
  const version = Math.min(local.max, remote.max)
  if (version >= Math.max(local.min, remote.min)) return { ok: true, version }
  const upgrade = remote.max < local.min ? 'extension' : local.max < remote.min ? 'host' : 'undetermined'
  return {
    ok: false,
    reason: 'no-overlap',
    local,
    remote,
    upgrade,
    message: `no protocol overlap: local ${local.min}-${local.max}, remote ${remote.min}-${remote.max}`,
  }
}
