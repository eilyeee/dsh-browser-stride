import type { ToolExecutionScope } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { ToolTargetLease } from './target-leases.ts'

export interface RunTargetBinding { readonly id: string; current(): boolean; accept(): boolean }
interface Binding { sessionId: string; id: string; target: ToolTargetLease; awaiting: boolean }

/** Worker-owned tab lifetime/binding pins; never infer identity from page text. */
export class RunTargetRegistry {
  private owner = {}
  private readonly entries = new Map<string, Binding>()
  private readonly prepared = new Map<string, { key: string; binding: Binding }>()
  constructor(private readonly capacity = 5000, private readonly makeId = () => `page_${crypto.randomUUID()}`) {}

  /** A user-selected future revision; never usable as an unscoped first pin. */
  prepare(scope: Extract<ToolExecutionScope, { kind: 'run' }>, sessionId: string, target: ToolTargetLease): Pick<RunTargetBinding, 'id' | 'current'> | undefined {
    const key = JSON.stringify([scope.runId, scope.controlRevision])
    if (!target.current() || this.entries.has(key) || this.entries.size + this.prepared.size >= this.capacity) return
    const binding: Binding = { sessionId, id: this.makeId(), target, awaiting: true }
    this.prepared.set(binding.id, { key, binding })
    const owner = this.owner
    return Object.freeze({ id: binding.id, current: () => this.owner === owner && binding.target.current()
      && (this.prepared.get(binding.id)?.binding === binding || this.entries.get(key) === binding) })
  }

  join(scope: Extract<ToolExecutionScope, { kind: 'run' }>, sessionId: string, target: ToolTargetLease, expected?: string): RunTargetBinding | undefined {
    if (!target.current()) return
    const key = JSON.stringify([scope.runId, scope.controlRevision])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      if (expected !== undefined) {
        const prepared = this.prepared.get(expected)
        // A missing pin after restart cannot be recreated from a Host's old id.
        if (prepared?.key !== key || prepared.binding.sessionId !== sessionId || !prepared.binding.target.current()) return
        entry = prepared.binding
        this.prepared.delete(expected)
      } else {
        if (this.entries.size + this.prepared.size >= this.capacity || [...this.prepared.values()].some(value => value.key === key)) return
        entry = { sessionId, id: this.makeId(), target, awaiting: false }
      }
      this.entries.set(key, entry)
    }
    if (entry.sessionId !== sessionId || (expected !== undefined && entry.id !== expected)
      || !entry.target.sameBinding() || entry.target.target.tabId !== target.target.tabId
      || entry.target.target.windowId !== target.target.windowId) return
    const binding = entry
    const owner = this.owner
    const current = () => this.owner === owner && this.entries.get(key) === binding
      && binding.target.sameBinding() && (!binding.awaiting || binding.target.current())
    return Object.freeze({ id: entry.id, current, accept: () => {
      if (!current() || !target.current()) return false
      binding.awaiting = false
      return true
    } })
  }

  revokeAll(): void { this.owner = {}; this.entries.clear(); this.prepared.clear() }
}
