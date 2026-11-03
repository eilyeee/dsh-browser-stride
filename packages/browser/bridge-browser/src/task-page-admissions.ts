import { randomUUID } from 'node:crypto'
import type { RunId } from './contracts/ids.ts'
import type { BrowserRunRecord } from './run-store.ts'
import { taskPageUrl } from './protocol.ts'

export class TaskPageAdmissionError extends Error {
  constructor(readonly mayHaveStarted = false) { super('Task page start is unavailable or already reserved') }
}
interface Admission {
  runId: RunId; sessionId: string; version: number; revision: number; owner: object
  id: string; url: string; expiresAt: number; consumed: boolean
}
/** Connection-owned, single-use native launch reservations. Never recovery authority. */
export class TaskPageAdmissions {
  private readonly entries = new Map<RunId, Admission>()
  constructor(private readonly get: (id: RunId) => BrowserRunRecord | undefined,
    private readonly now = () => Date.now(), private readonly makeId = () => `start_${randomUUID()}`,
    private readonly capacity = 5000) {}

  private prune(id: RunId): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    const run = this.get(id)
    if (run === undefined || run.state !== 'queued' || run.version !== entry.version || run.controlRevision !== entry.revision
      || (!entry.consumed && this.now() >= entry.expiresAt)) this.entries.delete(id)
  }
  available(run: BrowserRunRecord): boolean {
    this.prune(run.runId)
    return run.state === 'queued' && run.task !== undefined && !run.recoveryRequired && !this.entries.has(run.runId)
  }
  reserve(run: BrowserRunRecord, input: { expectedVersion: number; controlRevision: number; url: unknown }, owner: object) {
    const url = taskPageUrl(input.url)
    if (url === undefined || !this.available(run) || run.version !== input.expectedVersion || run.controlRevision !== input.controlRevision) throw new TaskPageAdmissionError()
    if (this.entries.size >= this.capacity) for (const id of this.entries.keys()) this.prune(id)
    if (this.entries.size >= this.capacity) throw new TaskPageAdmissionError()
    const entry: Admission = { runId: run.runId, sessionId: run.sessionId, version: run.version, revision: run.controlRevision,
      owner, id: this.makeId(), url, expiresAt: this.now() + 45000, consumed: false }
    this.entries.set(run.runId, entry)
    return { startTicket: entry.id, launchUrl: url, expiresAt: entry.expiresAt }
  }
  consume(run: BrowserRunRecord, input: { startTicket: string; launchUrl: string | undefined; expectedVersion: number; controlRevision: number }, owner: object): void {
    const entry = this.entries.get(run.runId)
    if (entry?.consumed && entry.owner === owner && entry.id === input.startTicket) throw new TaskPageAdmissionError(true)
    if (entry === undefined || entry.owner !== owner || entry.id !== input.startTicket || entry.consumed
      || this.now() >= entry.expiresAt || entry.sessionId !== run.sessionId || run.state !== 'queued'
      || run.version !== entry.version || input.expectedVersion !== entry.version || run.controlRevision !== entry.revision
      || input.controlRevision !== entry.revision || input.launchUrl !== entry.url) throw new TaskPageAdmissionError()
    // A queued consumed reservation is retained after timeout/storage uncertainty.
    entry.consumed = true
  }
  assertUnreserved(run: BrowserRunRecord): void {
    this.prune(run.runId)
    if (this.entries.has(run.runId)) throw new TaskPageAdmissionError()
  }
  cancel(runId: RunId, sessionId: string, ticket: string, owner: object): boolean {
    const entry = this.entries.get(runId)
    if (entry === undefined || entry.owner !== owner || entry.id !== ticket || entry.sessionId !== sessionId || entry.consumed) return false
    this.entries.delete(runId)
    return true
  }
}
