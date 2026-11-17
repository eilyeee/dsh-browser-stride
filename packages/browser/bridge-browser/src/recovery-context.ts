/** Bounded review context, never action arguments, page text or a success verdict. */
import type { DispatchRecord } from './dispatch-ledger.ts'

const outcomes = ['no-reply', 'reply-error', 'readback-unconfirmed', 'review-invalidated'] as const
export interface RecoveryWriteContext {
  operation: string
  occurredAt?: string
  outcome: typeof outcomes[number]
}
const operationPattern = /^browser_[a-z_]{1,60}$/

/** Uses the existing label field so older peers can still parse the offer. */
export function recoveryWriteLabel(row: Pick<DispatchRecord, 'name' | 'preparedAt' | 'receipt' | 'nativeReviewInvalidated'>): string {
  const operation = operationPattern.test(row.name) ? row.name : 'browser_operation'
  const time = Number.isSafeInteger(row.preparedAt) && row.preparedAt >= 0 && row.preparedAt <= 8_640_000_000_000_000
    ? new Date(row.preparedAt).toISOString() : '-'
  const outcome: RecoveryWriteContext['outcome'] = row.nativeReviewInvalidated === true ? 'review-invalidated'
    : row.receipt?.readbackUnconfirmed === true ? 'readback-unconfirmed'
      : row.receipt?.ok === false ? 'reply-error' : 'no-reply'
  return `v1|${operation}|${time}|${outcome}`
}

export function parseRecoveryWriteLabel(label: string): RecoveryWriteContext | undefined {
  if (label.length > 200) return undefined
  const parts = label.split('|')
  if (parts.length !== 4 || parts[0] !== 'v1' || !operationPattern.test(parts[1]!)
    || !(outcomes as readonly string[]).includes(parts[3]!)) return undefined
  const time = parts[2]!
  if (time !== '-') {
    const parsed = new Date(time)
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== time) return undefined
  }
  return { operation: parts[1]!, ...(time === '-' ? {} : { occurredAt: time }), outcome: parts[3] as RecoveryWriteContext['outcome'] }
}
