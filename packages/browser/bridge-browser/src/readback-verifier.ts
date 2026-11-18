/** Trusted Host adapter for independent, versioned backend readback. No browser/model RPC. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { BrowserTaskVerifier } from './task-runtime.ts'

const segment = z.string().min(1).max(80).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
const path = z.array(segment).min(1).max(12)
const primitive = z.union([
  z.string().max(512),
  z.number().finite().refine(value => !Number.isInteger(value) || Number.isSafeInteger(value)),
  z.boolean(),
  z.null(),
])
const int64 = z.string().refine(value => {
  if (!/^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) return false
  const integer = BigInt(value)
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n
})
const fieldCheck = z.union([
  z.strictObject({ path, equals: primitive }),
  z.strictObject({ path, equalsInt64: int64 }),
])
const versionValue = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.iso.datetime({ offset: true }).max(64),
])
const configSchema = z.strictObject({
  targetUrl: z.string().max(2048), contextKey: z.string().min(1).max(200),
  versionPath: path, baselineVersion: versionValue,
  checks: z.array(fieldCheck).min(1).max(32),
  timeoutMs: z.number().int().min(1).max(15_000).default(10_000),
})
export interface IndependentReadback {
  /** JSON obtained from the authoritative record API, never a toast or model response. */
  body: string
  /** Trusted adapter's account/tenant/record scope, captured before dispatch. Not a credential. */
  contextKey: string
  /** Host time at which this fresh read completed. */
  observedAt: number
  /** Immutable private artifact created by the trusted reader; no raw body is stored in the run. */
  artifactRef: string
}
export type ReadbackVerifierConfig = z.input<typeof configSchema> & {
  read(input: { runId: string; controlRevision: number; targetUrl: string; signal: AbortSignal }): Promise<IndependentReadback>
}
const resultSchema = z.strictObject({ body: z.string().max(262_144), contextKey: z.string().min(1).max(200),
  observedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), artifactRef: z.string().regex(/^readback_[a-zA-Z0-9_-]{1,120}$/) })
function target(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
function at(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

type NumberSources = WeakMap<object, Map<string, string>>

function parseReadback(body: string, numberSources: NumberSources | undefined): unknown {
  if (numberSources === undefined) return JSON.parse(body)
  return JSON.parse(body, function (this: object, key: string, value: unknown, context?: { source: string }) {
    if (typeof value !== 'number' || context === undefined) return value
    // Preserve the literal even for parsed safe integers, which may be rounded fractions.
    let fields = numberSources.get(this)
    if (fields === undefined) {
      fields = new Map()
      numberSources.set(this, fields)
    }
    fields.set(key, context.source)
    return value
  })
}

function matchesField(body: unknown, check: z.output<typeof fieldCheck>, numberSources: NumberSources | undefined): boolean {
  if ('equals' in check) return at(body, check.path) === check.equals
  const key = check.path.at(-1)!
  const parent = at(body, check.path.slice(0, -1))
  if (typeof parent !== 'object' || parent === null) return false
  const value = at(parent, [key])
  if (typeof value === 'string') return value === check.equalsInt64
  return typeof value === 'number' && numberSources?.get(parent)?.get(key) === check.equalsInt64
}

function comparableVersion(value: number | string): number {
  return typeof value === 'number' ? value : Date.parse(value)
}

/**
 * Install from trusted Host code using runtime.registerVerifier while queued.
 * The reader must independently enforce read-only access and authoritative identity.
 * A newer backend version plus all exact postconditions are required; HTTP 200 alone
 * proves nothing. Timeout/mismatch/missing identity never retries or verifies a task.
 */
export function createReadbackVerifier(input: ReadbackVerifierConfig): BrowserTaskVerifier {
  const { read, ...values } = input
  const parsed = configSchema.safeParse(values)
  if (!parsed.success || typeof read !== 'function') throw new Error('readback-config-invalid')
  const config = parsed.data, expectedTarget = target(config.targetUrl)
  const baseline = comparableVersion(config.baselineVersion)
  if (expectedTarget === undefined || !Number.isSafeInteger(baseline)) throw new Error('readback-config-invalid')
  const acceptsTarget = (url: string) => target(url) === expectedTarget
  const needsNumberSources = config.checks.some(check => 'equalsInt64' in check)
  return Object.freeze({ acceptsTarget, verify: async ({ run, url, signal }: Parameters<BrowserTaskVerifier['verify']>[0]) => {
    if (signal.aborted || !acceptsTarget(url)) return undefined
    const startedAt = Date.now(), timeout = new AbortController()
    const bounded = AbortSignal.any([signal, timeout.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    let aborted: (() => void) | undefined
    try {
      const expired = new Promise<never>((_, reject) => {
        aborted = () => reject(new Error('readback-unavailable'))
        bounded.addEventListener('abort', aborted, { once: true })
        timer = setTimeout(() => timeout.abort(), config.timeoutMs)
      })
      const result = resultSchema.safeParse(await Promise.race([expired, Promise.resolve().then(() => {
        bounded.throwIfAborted()
        return read({ runId: String(run.runId), controlRevision: run.controlRevision, targetUrl: expectedTarget, signal: bounded })
      })]))
      if (bounded.aborted || !result.success || result.data.contextKey !== config.contextKey
        || result.data.observedAt < startedAt || result.data.observedAt > Date.now()) return undefined
      const numberSources: NumberSources | undefined = needsNumberSources ? new WeakMap() : undefined
      const body = parseReadback(result.data.body, numberSources)
      const version = versionValue.safeParse(at(body, config.versionPath))
      if (!version.success || typeof version.data !== typeof config.baselineVersion || !(comparableVersion(version.data) > baseline)
        || !config.checks.every(check => matchesField(body, check, numberSources))) return undefined
      return { url: expectedTarget, artifactRefs: [result.data.artifactRef, `readback-sha256:${createHash('sha256').update(result.data.body).digest('hex')}`] }
    } catch { return undefined }
    finally { clearTimeout(timer); if (aborted !== undefined) bounded.removeEventListener('abort', aborted) }
  } })
}
