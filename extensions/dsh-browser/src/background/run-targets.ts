import type { ToolExecutionScope } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { ToolTargetLease } from './target-leases.ts'

export interface RunTargetBinding { readonly id: string; current(): boolean }
interface Binding { sessionId: string; id: string; target: ToolTargetLease }

/** Worker-owned tab lifetime/binding pins; never infer identity from page text. */
export class RunTargetRegistry {
  private owner = {}
  private readonly entries = new Map<string, Binding>()
  constructor(private readonly capacity = 5000, private readonly makeId = () => `page_${crypto.randomUUID()}`) {}

  join(scope: Extract<ToolExecutionScope, { kind: 'run' }>, sessionId: string, target: ToolTargetLease, expected?: string): RunTargetBinding | undefined {
    if (!target.current()) return
    const key = JSON.stringify([scope.runId, scope.controlRevision])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      // A missing pin after restart cannot be recreated using a Host's old id.
      if (expected !== undefined || this.entries.size >= this.capacity) return
      entry = { sessionId, id: this.makeId(), target }
      this.entries.set(key, entry)
    }
    if (entry.sessionId !== sessionId || (expected !== undefined && entry.id !== expected)
      || !entry.target.sameBinding() || entry.target.target.tabId !== target.target.tabId
      || entry.target.target.windowId !== target.target.windowId) return
    const binding = entry
    const owner = this.owner
    return Object.freeze({ id: entry.id, current: () => this.owner === owner
      && this.entries.get(key) === binding && binding.target.sameBinding() })
  }

  revokeAll(): void { this.owner = {}; this.entries.clear() }
}
