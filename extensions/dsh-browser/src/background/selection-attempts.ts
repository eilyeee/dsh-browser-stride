/** Bounded, worker-local evidence of native panel selections; never authority. */
export type SelectionAttemptStatus =
  | { state: 'not-observed' | 'pending' | 'selected' }
  | { state: 'failed'; code: string }

const CODES = new Set(['binding-busy', 'binding-storage', 'no-active-tab', 'timeout', 'cancelled', 'page-access-required', 'stale-binding'])

export function selectionAttemptSummary(value: SelectionAttemptStatus): SelectionAttemptStatus {
  return value.state === 'failed'
    ? { state: 'failed', code: CODES.has(value.code) ? value.code : 'no-active-tab' }
    : { state: value.state }
}

export class SelectionAttempts {
  private entries = new Map<string, { expiresAt: number; status: SelectionAttemptStatus }>()
  constructor(private now = Date.now, private ttlMs = 300_000, private capacity = 64) {}

  begin(sessionId: string): (code?: string) => void {
    this.prune()
    const entry = { expiresAt: this.now() + this.ttlMs, status: { state: 'pending' } as SelectionAttemptStatus }
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    return code => {
      if (this.entries.get(sessionId) !== entry || entry.expiresAt <= this.now()) return
      entry.status = code === undefined ? { state: 'selected' } : { state: 'failed', code: CODES.has(code) ? code : 'no-active-tab' }
    }
  }

  snapshot(sessionId?: string): SelectionAttemptStatus {
    this.prune()
    const status = sessionId === undefined ? undefined : this.entries.get(sessionId)?.status
    return status === undefined ? { state: 'not-observed' } : { ...status }
  }

  private prune(): void {
    for (const [sid, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(sid)
  }
}
