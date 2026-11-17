import { describe, expect, it } from 'vitest'
import { parseRecoveryWriteLabel, recoveryWriteLabel } from '../src/recovery-context.ts'

describe('bounded recovery context', () => {
  const row = { name: 'browser_click', preparedAt: 1_800_000_000_000 }
  it.each([
    [{}, 'no-reply'],
    [{ receipt: { ok: false as const, errorCode: 'action-failed' as const } }, 'reply-error'],
    [{ receipt: { ok: true as const, readbackUnconfirmed: true as const } }, 'readback-unconfirmed'],
    [{ receipt: { ok: false as const, errorCode: 'unknown' as const }, nativeReviewInvalidated: true }, 'review-invalidated'],
  ] as const)('distinguishes review reasons without claiming a business outcome (%j)', (extra, outcome) => {
    const label = recoveryWriteLabel({ ...row, ...extra })
    expect(label.length).toBeLessThanOrEqual(200)
    expect(parseRecoveryWriteLabel(label)).toEqual({ operation: row.name, occurredAt: new Date(row.preparedAt).toISOString(), outcome })
  })
  it('never copies an arbitrary operation name or invalid date into context', () => {
    const label = recoveryWriteLabel({ name: 'private page content', preparedAt: Number.MAX_SAFE_INTEGER })
    expect(label).not.toContain('private')
    expect(parseRecoveryWriteLabel(label)).toEqual({ operation: 'browser_operation', outcome: 'no-reply' })
  })
  it.each(['browser_click', 'v1|browser_click|2026-11-17|no-reply', 'v1|browser_click|-|completed', 'v1|browser_click|-|no-reply|extra', 'v1|private title|-|no-reply'])('leaves legacy or malformed context unparsed (%s)', label => {
    expect(parseRecoveryWriteLabel(label)).toBeUndefined()
  })
})
