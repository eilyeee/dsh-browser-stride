/** Host transport records, not business-success facts or a replay queue. */
import { createHash } from 'node:crypto'
import { defineDomain, domainTable, type Domain, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { canonicalize, makeActionId } from './contracts/ids.ts'
import { isReadOnlyBrowserTool } from './protocol.ts'
import { toolCommandMaterial } from './tool-identity.ts'

const id = z.string().min(1).max(200).refine(value => value.trim() === value)
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const reason = z.enum(['cancelled', 'expired', 'connection-closed', 'send-failed', 'interrupted'])
const errorCode = z.enum([
  'no-active-tab', 'content-unavailable', 'action-failed', 'timeout', 'bridge-closed', 'bad-args', 'internal', 'unknown',
  'action-duplicate', 'action-conflict', 'receipt-unavailable',
])
const receipt = z.strictObject({ ok: z.boolean(), errorCode: errorCode.optional() })
  .refine(value => value.ok ? value.errorCode === undefined : value.errorCode !== undefined)
export function transportReceipt(ok: boolean, code?: string): z.infer<typeof receipt> {
  const parsed = errorCode.safeParse(code)
  return ok ? { ok: true } : { ok: false, errorCode: parsed.success ? parsed.data : 'unknown' }
}
const recordSchema = z.strictObject({
  actionId: id, requestId: id, connectionId: id,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  identityVersion: z.literal(2).optional(),
  transportDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  installationId: id.optional(), sessionId: id.optional(), name: id,
  effect: z.enum(['read', 'write']),
  state: z.enum(['prepared', 'sent_unconfirmed', 'not_sent', 'unresolved', 'returned']),
  preparedAt: time, expiresAt: time,
  dispatchMarkedAt: time.optional(), settledAt: time.optional(),
  interruption: z.strictObject({ reason, at: time }).optional(),
  receipt: receipt.optional(),
}).superRefine((row, ctx) => {
  const marked = row.dispatchMarkedAt !== undefined
  const settled = row.settledAt !== undefined
  const valid = row.expiresAt > 0
    && (row.identityVersion === 2 ? row.transportDigest !== undefined : row.transportDigest === undefined)
    && row.effect === (isReadOnlyBrowserTool(row.name) ? 'read' : 'write')
    && (row.dispatchMarkedAt === undefined || row.dispatchMarkedAt >= row.preparedAt)
    && (row.settledAt === undefined || row.settledAt >= (row.dispatchMarkedAt ?? row.preparedAt))
    && (row.interruption === undefined || (row.interruption.at >= row.preparedAt && settled && row.interruption.at <= row.settledAt!))
    && (row.state === 'prepared' ? !marked && !settled && row.interruption === undefined && row.receipt === undefined
      : row.state === 'sent_unconfirmed' ? marked && !settled && row.interruption === undefined && row.receipt === undefined
      : row.state === 'not_sent' ? settled && row.interruption !== undefined && row.receipt === undefined
      : row.state === 'unresolved' ? marked && settled && row.interruption !== undefined && row.receipt === undefined
      : marked && settled && row.receipt !== undefined)
  if (!valid) ctx.addIssue({ code: 'custom', message: 'inconsistent dispatch record' })
})

export type DispatchRecord = z.infer<typeof recordSchema>
export type DispatchSettlement =
  | { state: 'not_sent' | 'unresolved'; reason: z.infer<typeof reason> }
  | { state: 'returned'; receipt: z.infer<typeof receipt> }
const settlementSchema = z.union([
  z.strictObject({ state: z.enum(['not_sent', 'unresolved']), reason }),
  z.strictObject({ state: z.literal('returned'), receipt }),
])

function specFor(profile: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new TypeError('invalid dispatch profile')
  return defineDomain({ name: `browser_dispatches_${Buffer.from(profile).toString('hex')}`, version: 1,
    tables: { dispatches: domainTable(recordSchema) } })
}
type DispatchDomain = Domain<ReturnType<typeof specFor>>

/** Stable diagnostics never include raw arguments, page text or peer errors. */
export class DispatchLedgerError extends Error {
  constructor(readonly code: 'closed' | 'storage-unavailable' | 'not-found' | 'request-conflict' | 'invalid-state' | 'session-busy') {
    super(`browser dispatch ledger: ${code}`)
    this.name = 'DispatchLedgerError'
  }
}

/** One Host owns this domain; no method dispatches or retries an action. */
export class BrowserDispatchLedger {
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private writeFaulted = false
  private disposal: Promise<void> | undefined
  private constructor(private readonly domain: DispatchDomain) {}

  static async open(facility: Pick<DomainFacility, 'open'>, profile: string): Promise<BrowserDispatchLedger> {
    const domain = await facility.open(specFor(profile))
    const ledger = new BrowserDispatchLedger(domain)
    try {
      const rows = [...domain.table('dispatches').entries()]
      const actions = new Set<string>()
      for (const [key, row] of rows) {
        if (key !== row.requestId || actions.has(row.actionId)) throw new TypeError('invalid dispatch identity')
        actions.add(row.actionId)
      }
      for (const [, row] of rows) {
        if (row.state === 'prepared' || row.state === 'sent_unconfirmed') {
          await ledger.settle(row.requestId, { state: row.state === 'prepared' ? 'not_sent' : 'unresolved', reason: 'interrupted' })
        }
      }
      return ledger
    } catch (error) { await domain.close(); throw error }
  }

  get(requestId: string): DispatchRecord | undefined {
    this.assertOpen()
    const row = this.domain.table('dispatches').get(requestId)
    return row === undefined ? undefined : structuredClone(row)
  }

  list(sessionId?: string): DispatchRecord[] {
    this.assertOpen()
    return [...this.domain.table('dispatches').entries()].map(([, row]) => row)
      .filter(row => sessionId === undefined || row.sessionId === sessionId).map(row => structuredClone(row))
  }

  prepare(input: { requestId: string; connectionId: string; installationId?: string; sessionId?: string;
    name: string; args: Record<string, unknown>; expiresAt: number }): Promise<DispatchRecord> {
    // Snapshot before awaiting anything. Only the digest and metadata survive
    // this method: field values, credentials and page content are not stored.
    const material = canonicalize(input)
    const { args, ...metadata } = JSON.parse(material) as typeof input
    const transportDigest = createHash('sha256').update(material).digest('hex')
    return this.exclusive(async () => {
      const existing = this.domain.table('dispatches').get(metadata.requestId)
      if (existing !== undefined) {
        if ((existing.transportDigest ?? existing.requestDigest) !== transportDigest) throw new DispatchLedgerError('request-conflict')
        return structuredClone(existing)
      }
      const actionId = makeActionId()
      const requestDigest = createHash('sha256').update(toolCommandMaterial({ actionId, name: metadata.name, args,
        ...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }) })).digest('hex')
      const candidate = recordSchema.parse({ ...metadata, actionId, requestDigest, transportDigest, identityVersion: 2,
        effect: isReadOnlyBrowserTool(metadata.name) ? 'read' : 'write', state: 'prepared', preparedAt: Date.now() })
      await this.persist(candidate)
      return structuredClone(candidate)
    })
  }

  markSent(requestId: string): Promise<DispatchRecord> {
    return this.exclusive(async () => {
      const row = this.require(requestId)
      if (row.state !== 'prepared') throw new DispatchLedgerError('invalid-state')
      return this.save({ ...row, state: 'sent_unconfirmed', dispatchMarkedAt: Math.max(Date.now(), row.preparedAt) })
    })
  }

  settle(requestId: string, settlement: DispatchSettlement): Promise<DispatchRecord> {
    const result = settlementSchema.parse(settlement)
    return this.exclusive(async () => {
      const row = this.require(requestId)
      const now = Math.max(Date.now(), row.settledAt ?? row.dispatchMarkedAt ?? row.preparedAt)
      if (result.state === 'returned') {
        if (row.state === 'returned') {
          if (canonicalize(row.receipt) !== canonicalize(result.receipt)) throw new DispatchLedgerError('request-conflict')
          return structuredClone(row)
        }
        if (row.state !== 'sent_unconfirmed' && row.state !== 'unresolved') throw new DispatchLedgerError('invalid-state')
        return this.save({ ...row, state: 'returned', settledAt: now, receipt: result.receipt })
      }
      if (row.state === 'returned' || row.state === result.state) return structuredClone(row)
      if (row.state !== 'prepared' && row.state !== 'sent_unconfirmed') throw new DispatchLedgerError('invalid-state')
      if (result.state === 'unresolved' && row.state !== 'sent_unconfirmed') throw new DispatchLedgerError('invalid-state')
      return this.save({ ...row, state: result.state, settledAt: now,
        interruption: { reason: result.reason, at: now } })
    })
  }

  /** Exclude concurrent prepares while the owning session is being purged. */
  purgeSession(sessionId: string, purgeStorage: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      const rows = [...this.domain.table('dispatches').entries()].filter(([, row]) => row.sessionId === sessionId)
      if (rows.some(([, row]) => row.state === 'prepared' || row.state === 'sent_unconfirmed')) throw new DispatchLedgerError('session-busy')
      await purgeStorage()
      for (const [key] of rows) {
        try { await this.domain.table('dispatches').delete(key) }
        catch (error) { this.writeFaulted = true; throw error }
      }
    })
  }

  close(): Promise<void> {
    this.closing = true
    return this.disposal ??= this.tail.then(() => this.domain.close())
  }
  private assertOpen(): void { if (this.closing) throw new DispatchLedgerError('closed') }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const pending = this.tail.then(() => {
      if (this.writeFaulted) throw new DispatchLedgerError('storage-unavailable')
      return work()
    })
    this.tail = pending.then(() => undefined, () => undefined)
    return pending
  }
  private require(requestId: string): DispatchRecord {
    const row = this.domain.table('dispatches').get(requestId)
    if (row === undefined) throw new DispatchLedgerError('not-found')
    return row
  }
  private async save(row: DispatchRecord): Promise<DispatchRecord> {
    const parsed = recordSchema.parse(row)
    await this.persist(parsed)
    return structuredClone(parsed)
  }
  private async persist(row: DispatchRecord): Promise<void> {
    try { await this.domain.table('dispatches').put(row.requestId, row) }
    catch (error) { this.writeFaulted = true; throw error }
  }
}
